targetScope = 'resourceGroup'

@description('Deploy this access template in the existing vault resource group, Common, only after IAM approval.')
param vaultName string = 'kai-home-apps-KV'
param runtimeObjectId string
param passwordSecretName string = 'friendTriviaAdminPassword'
param sessionKeySecretName string = 'friendTriviaAdminSessionKey'

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = { name: vaultName }
var names = [passwordSecretName, sessionKeySecretName]
resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = [for name in names: {
  parent: vault
  name: name
}]
resource secretReaders 'Microsoft.Authorization/roleAssignments@2022-04-01' = [for (name, i) in names: {
  name: guid(secrets[i].id, runtimeObjectId, 'friends-trivia-secret-reader')
  scope: secrets[i]
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
    principalId: runtimeObjectId
    principalType: 'ServicePrincipal'
  }
}]
