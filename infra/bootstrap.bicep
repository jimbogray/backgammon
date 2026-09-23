// One-time setup for an environment of the backgammon app (staging by default).
// Run it yourself, once, with Owner on the resource group; see infra/README.md.
// Everything else lives in main.bicep, which the pipeline deploys on every merge.
//
// Creates what the pipeline itself needs before it can run, plus the role
// assignments (which the pipeline is deliberately not allowed to make):
//   - Azure Container Registry for the API image
//   - The identity GitHub Actions signs in as (OIDC, no secrets), trusted only
//     for the given GitHub environment, with Contributor on this resource group
//   - The identity the API runs as, allowed to pull from the registry

@description('Environment name. Also the GitHub environment the deploy identity trusts.')
param environmentName string = 'staging'

@description('GitHub repository in owner/name form, for example jimbogray/backgammon.')
param githubRepo string

@description('Start of the GitHub OIDC token subject, before ":environment:". Repositories using immutable subjects need the ID form, repo:owner@ownerId/name@repoId; `gh api repos/OWNER/REPO/actions/oidc/customization/sub --jq .sub_claim_prefix` prints it. Defaults to repo:<githubRepo>.')
param githubSubjectPrefix string = 'repo:${githubRepo}'

@description('Azure region. Defaults to the resource group\'s region.')
param location string = resourceGroup().location

var names = {
  registry: 'backgammon${uniqueString(resourceGroup().id)}'
  deployIdentity: 'id-backgammon-${environmentName}-deploy'
  apiIdentity: 'id-backgammon-${environmentName}-api'
}
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
  name: names.registry
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource deployIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: names.deployIdentity
  location: location
  tags: tags
}

resource githubFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: deployIdentity
  name: 'github-${environmentName}'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: '${githubSubjectPrefix}:environment:${environmentName}'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// Lets the pipeline deploy main.bicep into this resource group. Contributor
// can't assign roles, which is why the role assignments live in this file.
resource deployManagesResourceGroup 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deployIdentity.id, roles.contributor)
  properties: {
    principalId: deployIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.contributor)
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

// The API's identity: pulls its image, and signs in to Postgres (main.bicep
// makes it the database's Microsoft Entra administrator).
resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: names.apiIdentity
  location: location
  tags: tags
}

resource apiPullsFromRegistry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, apiIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: apiIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

// Set these as variables on the GitHub environment.
output AZURE_CLIENT_ID string = deployIdentity.properties.clientId
output AZURE_TENANT_ID string = subscription().tenantId
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output AZURE_RESOURCE_GROUP string = resourceGroup().name
output AZURE_REGISTRY_NAME string = registry.name
