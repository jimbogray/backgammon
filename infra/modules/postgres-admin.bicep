// Makes a managed identity a Microsoft Entra administrator of a Postgres Flexible Server.
// A module because the administrator's resource name is the identity's object ID,
// which is only known once the deployment is running.

param serverName string
param principalId string
param principalName string

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: serverName
}

resource admin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2024-08-01' = {
  parent: postgres
  name: principalId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: principalName
    tenantId: subscription().tenantId
  }
}
