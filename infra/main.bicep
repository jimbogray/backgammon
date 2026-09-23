// Azure resources for one environment of the backgammon app (staging by default).
// The deploy pipeline runs this on every merge to main, after pushing the API
// image; bootstrap.bicep must have been deployed to the same resource group first.
//
//   Browser ──► Static Web App (React build)
//      └──────► Container App (Express API) ──► Postgres Flexible Server
//
// The API signs in to Postgres with its managed identity (Microsoft Entra auth;
// password sign-in is off), so there is no database password anywhere.

@description('Environment name, matching bootstrap.bicep.')
param environmentName string = 'staging'

@description('Azure region. Defaults to the resource group\'s region.')
param location string = resourceGroup().location

@description('Region for the Static Web App, which is only offered in a few (the site itself is served worldwide).')
@allowed(['westus2', 'centralus', 'eastus2', 'westeurope', 'eastasia'])
param staticWebAppLocation string = 'eastus2'

@description('API container image, for example <registry>.azurecr.io/backgammon-api:<sha>.')
param apiImage string

@description('Fewest API replicas. 1 keeps it warm; 0 scales to zero when idle (slow first request).')
@minValue(0)
param apiMinReplicas int = 1

@description('Most API replicas. Live updates go through Postgres, so any number works.')
@minValue(1)
param apiMaxReplicas int = 3

@description('Google OAuth client ID. Leave empty to keep Google sign-in off.')
param googleClientId string = ''

@secure()
@description('Google OAuth client secret. Leave empty to keep Google sign-in off.')
param googleClientSecret string = ''

var suffix = uniqueString(resourceGroup().id)
var names = {
  registry: 'backgammon${suffix}'
  apiIdentity: 'id-backgammon-${environmentName}-api'
  logs: 'log-backgammon-${environmentName}'
  postgres: 'psql-backgammon-${environmentName}-${take(suffix, 6)}'
  containerEnv: 'cae-backgammon-${environmentName}'
  api: 'ca-backgammon-${environmentName}-api'
  web: 'swa-backgammon-${environmentName}'
}
var databaseName = 'backgammon'
var tags = {
  app: 'backgammon'
  environment: environmentName
}
var googleEnabled = !empty(googleClientId) && !empty(googleClientSecret)

// Created by bootstrap.bicep.
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: names.registry
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: names.apiIdentity
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: names.logs
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: names.postgres
  location: location
  tags: tags
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '17'
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: subscription().tenantId
    }
    storage: {
      storageSizeGB: 32
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
  }
}

// Consumption-plan Container Apps have no fixed outbound IPs, so allow Azure
// services in. Sign-in still needs a Microsoft Entra token for an allowed identity.
resource postgresAllowAzure 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = {
  parent: postgres
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// The API's identity administers the server, so it can create the database and
// its tables on first start. The server allows one change at a time, hence dependsOn.
module postgresApiAdmin 'modules/postgres-admin.bicep' = {
  name: 'postgres-api-admin'
  params: {
    serverName: postgres.name
    principalId: apiIdentity.properties.principalId
    principalName: apiIdentity.name
  }
  dependsOn: [
    postgresAllowAzure
  ]
}

resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: names.web
  location: staticWebAppLocation
  tags: tags
  sku: {
    name: 'Free'
    tier: 'Free'
  }
  properties: {}
}

resource containerEnv 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: names.containerEnv
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

var appUrl = 'https://${web.properties.defaultHostname}'
var apiUrl = 'https://${names.api}.${containerEnv.properties.defaultDomain}'

var baseEnv = [
  { name: 'APP_URL', value: appUrl }
  { name: 'API_URL', value: apiUrl }
  {
    name: 'DATABASE_URL'
    value: 'postgresql://${apiIdentity.name}@${postgres.properties.fullyQualifiedDomainName}:5432/${databaseName}?sslmode=verify-full'
  }
  { name: 'DATABASE_AUTH', value: 'entra' }
  // Which managed identity DefaultAzureCredential should use.
  { name: 'AZURE_CLIENT_ID', value: apiIdentity.properties.clientId }
]
var googleEnv = googleEnabled
  ? [
      { name: 'GOOGLE_CLIENT_ID', value: googleClientId }
      { name: 'GOOGLE_CLIENT_SECRET', secretRef: 'google-client-secret' }
    ]
  : []

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: names.api
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${apiIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: containerEnv.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: apiIdentity.id
        }
      ]
      secrets: googleEnabled ? [{ name: 'google-client-secret', value: googleClientSecret }] : []
    }
    template: {
      containers: [
        {
          name: 'api'
          image: apiImage
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: concat(baseEnv, googleEnv)
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/healthz', port: 3000 }
              periodSeconds: 3
              failureThreshold: 20
            }
            {
              type: 'Liveness'
              httpGet: { path: '/healthz', port: 3000 }
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: { path: '/healthz', port: 3000 }
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: apiMinReplicas
        maxReplicas: apiMaxReplicas
        rules: [
          {
            // Each open game tab holds one live-update request, so scale on a generous count.
            name: 'http'
            http: {
              metadata: {
                concurrentRequests: '100'
              }
            }
          }
        ]
      }
    }
  }
  dependsOn: [
    postgresApiAdmin
  ]
}

output APP_URL string = appUrl
output API_URL string = apiUrl
output STATIC_WEB_APP_NAME string = web.name
output POSTGRES_HOST string = postgres.properties.fullyQualifiedDomainName
