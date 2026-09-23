// Azure resources for one environment of the backgammon app (staging by default).
//
// Deploy into an existing resource group; see infra/README.md for the full steps:
//   az deployment group create -g <resource-group> -f infra/main.bicep -p githubRepo=<owner>/<repo>
//
// Creates:
//   - Azure Container Registry holding the app image
//   - Linux App Service plan and a Web App running the container, with the SQLite
//     database on the app's persistent /home storage
//   - A user-assigned identity that GitHub Actions signs in as (OIDC, no secrets),
//     trusted only for the given GitHub environment

@description('Environment name. Also the GitHub environment the deploy identity trusts.')
param environmentName string = 'staging'

@description('GitHub repository in owner/name form, for example jimbogray/backgammon.')
param githubRepo string

@description('Azure region. Defaults to the resource group\'s region.')
param location string = resourceGroup().location

@description('Web app name. Becomes <name>.azurewebsites.net, so it must be globally unique.')
param appName string = 'backgammon-${environmentName}-${take(uniqueString(resourceGroup().id), 6)}'

@description('App Service plan SKU. B1 is the smallest tier with Always On.')
param planSku string = 'B1'

@description('Google OAuth client ID. Leave empty to keep Google sign-in off.')
param googleClientId string = ''

@secure()
@description('Google OAuth client secret. Leave empty to keep Google sign-in off.')
param googleClientSecret string = ''

var imageRepository = 'backgammon'
var registryName = 'backgammon${uniqueString(resourceGroup().id)}'
var appUrl = 'https://${appName}.azurewebsites.net'
var tags = {
  app: 'backgammon'
  environment: environmentName
}

// Built-in role definition IDs.
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${appName}-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: {
    name: planSku
  }
  properties: {
    reserved: true
  }
}

resource site 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  tags: tags
  kind: 'app,linux,container'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      // The pipeline deploys each commit by its SHA tag and also moves this tag, so
      // re-running this template keeps the latest deployed image. Until the first
      // pipeline run the image doesn't exist and the site shows an error page.
      linuxFxVersion: 'DOCKER|${registry.properties.loginServer}/${imageRepository}:${environmentName}'
      acrUseManagedIdentityCreds: true
      alwaysOn: true
      // Live updates are held in memory and SQLite is a single file: one instance only.
      numberOfWorkers: 1
      healthCheckPath: '/healthz'
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'WEBSITES_PORT', value: '3000' }
        // Mounts the persistent /home share into the container.
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'true' }
        { name: 'DATABASE_PATH', value: '/home/data/backgammon.db' }
        // /home is a network share, where SQLite's WAL mode is unreliable.
        { name: 'DATABASE_JOURNAL_MODE', value: 'delete' }
        { name: 'APP_URL', value: appUrl }
        { name: 'GOOGLE_CLIENT_ID', value: googleClientId }
        { name: 'GOOGLE_CLIENT_SECRET', value: googleClientSecret }
      ]
    }
  }
}

// Keep container stdout/stderr so `az webapp log tail` works.
resource siteLogs 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: site
  name: 'logs'
  properties: {
    httpLogs: {
      fileSystem: {
        enabled: true
        retentionInDays: 7
        retentionInMb: 35
      }
    }
  }
}

resource sitePullsFromRegistry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, site.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: site.identity.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

// Identity used by the GitHub Actions deploy job.
resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-github-deploy'
  location: location
  tags: tags
}

resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-${environmentName}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${githubRepo}:environment:${environmentName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource deployPushesToRegistry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, deployIdentity.id, roles.acrPush)
  scope: registry
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
  }
}

// Lets the pipeline update the web app's container image. Scoped to this
// resource group only.
resource deployManagesResourceGroup 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentity.id, roles.contributor)
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.contributor)
  }
}

// Set these as variables on the GitHub "staging" environment.
output AZURE_CLIENT_ID string = deployIdentity.properties.clientId
output AZURE_TENANT_ID string = subscription().tenantId
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output AZURE_REGISTRY_NAME string = registry.name
output AZURE_WEBAPP_NAME string = site.name
output APP_URL string = appUrl
