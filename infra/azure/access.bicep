targetScope = 'resourceGroup'

param cosmosAccount string
param storageAccount string
param runtimeObjectId string
param testObjectId string
param deployObjectId string
param appName string = ''
param developerTestObjectId string = ''

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' existing = { name: cosmosAccount }
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' existing = { name: storageAccount }
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' existing = { parent: storage, name: 'default' }
resource songs 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = { parent: blobs, name: 'songs' }
resource testSongs 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' existing = { parent: blobs, name: 'songs-tests' }
resource app 'Microsoft.Web/sites@2023-12-01' existing = { name: appName }
var dataContributor = '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
resource runtimeCosmos 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = {
  parent: cosmos
  name: guid(cosmos.id, runtimeObjectId, 'production-data')
  properties: { principalId: runtimeObjectId, roleDefinitionId: dataContributor, scope: '${cosmos.id}/dbs/friends-trivia' }
}
var testers = empty(developerTestObjectId) ? [testObjectId] : [testObjectId, developerTestObjectId]
resource testCosmos 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-11-15' = [for objectId in testers: {
  parent: cosmos
  name: guid(cosmos.id, objectId, 'test-data')
  properties: { principalId: objectId, roleDefinitionId: dataContributor, scope: '${cosmos.id}/dbs/friends-trivia-tests' }
}]
resource runtimeBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(songs.id, runtimeObjectId, 'blob-data')
  scope: songs
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: runtimeObjectId
    principalType: 'ServicePrincipal'
  }
}
resource testBlob 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (objectId, i) in testers: {
  name: guid(testSongs.id, objectId, 'blob-data')
  scope: testSongs
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
    principalId: objectId
    principalType: i == 0 ? 'ServicePrincipal' : 'User'
  }
}]
resource deployAccess 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(appName)) {
  name: guid(app.id, deployObjectId, 'website-contributor')
  scope: app
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'de139f84-1756-47ae-9be6-808fbbe84772')
    principalId: deployObjectId
    principalType: 'ServicePrincipal'
  }
}
