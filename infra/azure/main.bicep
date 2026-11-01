targetScope = 'resourceGroup'

@allowed(['centralus'])
param location string = 'centralus'
param humanOwner string = 'YogiJogiFresh'
@description('GitHub OIDC repository subject with immutable owner/repository IDs, without the repo: prefix.')
param repository string = 'YogiJogiFresh@12243528/FriendsTrivia@1362058355'
@description('False provisions the isolated data/test target before the application is ready.')
param includeApplication bool = false
@minValue(40)
@maxValue(40)
param budgetAmount int = 40
@secure()
param budgetEmail string = ''
param notifySubscriptionOwners bool = false
param budgetStartDate string
param budgetEndDate string

var suffix = uniqueString(resourceGroup().id)
var tags = { humanOwner: humanOwner, application: 'FriendsTrivia' }
var productionDatabase = 'friends-trivia'
var testDatabase = 'friends-trivia-tests'

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = [for name in ['runtime', 'deployer', 'tester']: {
  name: 'friends-trivia-${name}'
  location: location
  tags: tags
}]
resource deployFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identities[1]
  name: 'github-production'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${repository}:environment:azure-production'
    audiences: ['api://AzureADTokenExchange']
  }
}
resource testFederation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: identities[2]
  name: 'github-tests'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: 'repo:${repository}:environment:azure-tests'
    audiences: ['api://AzureADTokenExchange']
  }
}
resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-11-15' = {
  name: 'friends-trivia-${suffix}'
  location: location
  tags: tags
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    capabilities: [{ name: 'EnableServerless' }]
    locations: [{ locationName: location, failoverPriority: 0, isZoneRedundant: false }]
    enableAutomaticFailover: false
    enableMultipleWriteLocations: false
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: 'Tls12'
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 240
        backupRetentionIntervalInHours: 24
        backupStorageRedundancy: 'Local'
      }
    }
  }
}
resource databases 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-11-15' = [for name in [productionDatabase, testDatabase]: {
  parent: cosmos
  name: name
  properties: { resource: { id: name }, options: {} }
}]
resource games 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [for i in range(0, 2): {
  parent: databases[i]
  name: 'games'
  properties: {
    resource: {
      id: 'games'
      partitionKey: { paths: ['/pk'], kind: 'Hash', version: 2 }
      indexingPolicy: {
        indexingMode: 'consistent'
        automatic: true
        includedPaths: [{ path: '/*' }]
        excludedPaths: [{ path: '/"_etag"/?' }]
        compositeIndexes: [
          [
            { path: '/submission/elapsedMs', order: 'ascending' }
            { path: '/submission/id', order: 'ascending' }
          ]
          [
            { path: '/price', order: 'descending' }
            { path: '/submission/playerId', order: 'ascending' }
          ]
          [
            { path: '/price', order: 'ascending' }
            { path: '/submission/playerId', order: 'ascending' }
          ]
        ]
      }
    }
    options: {}
  }
}]
resource library 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-11-15' = [for i in range(0, 2): {
  parent: databases[i]
  name: 'library'
  properties: {
    resource: {
      id: 'library'
      partitionKey: { paths: ['/pk'], kind: 'Hash', version: 2 }
      indexingPolicy: { indexingMode: 'consistent', automatic: true, includedPaths: [{ path: '/*' }], excludedPaths: [{ path: '/"_etag"/?' }] }
    }
    options: {}
  }
}]
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'ft${suffix}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
  }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    isVersioningEnabled: true
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
  }
}
resource songs 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'songs'
  properties: { publicAccess: 'None' }
}
resource testSongs 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobs
  name: 'songs-tests'
  properties: { publicAccess: 'None' }
}
resource retention 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    policy: {
      rules: [{
        name: 'expire-old-versions'
        enabled: true
        type: 'Lifecycle'
        definition: {
          filters: { blobTypes: ['blockBlob'], prefixMatch: ['songs/', 'songs-tests/'] }
          actions: {
            version: { delete: { daysAfterCreationGreaterThan: 14 } }
            snapshot: { delete: { daysAfterCreationGreaterThan: 14 } }
          }
        }
      }]
    }
  }
}
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = if (includeApplication) {
  name: 'friends-trivia-plan'
  location: location
  tags: tags
  kind: 'linux'
  sku: { name: 'B1', tier: 'Basic', capacity: 1 }
  properties: { reserved: true }
}
resource app 'Microsoft.Web/sites@2023-12-01' = if (includeApplication) {
  name: 'friends-trivia-${suffix}'
  location: location
  tags: tags
  kind: 'app,linux'
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${identities[0].id}': {} } }
  properties: {
    serverFarmId: plan!.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'npm start'
      alwaysOn: true
      numberOfWorkers: 1
      webSocketsEnabled: true
      healthCheckPath: '/api/health'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      ftpsState: 'Disabled'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'FRIENDS_TRIVIA_MODE', value: 'cloud' }
        { name: 'HOST', value: '0.0.0.0' }
        { name: 'PORT', value: '8080' }
        { name: 'AZURE_CLIENT_ID', value: identities[0].properties.clientId }
        { name: 'COSMOS_ENDPOINT', value: cosmos.properties.documentEndpoint }
        { name: 'COSMOS_DATABASE', value: productionDatabase }
        { name: 'COSMOS_GAMES_CONTAINER', value: 'games' }
        { name: 'COSMOS_LIBRARY_CONTAINER', value: 'library' }
        { name: 'AZURE_STORAGE_ACCOUNT_URL', value: storage.properties.primaryEndpoints.blob }
        { name: 'AZURE_STORAGE_CONTAINER', value: songs.name }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'false' }
        { name: 'WEBSITE_HEALTHCHECK_MAXPINGFAILURES', value: '3' }
      ]
    }
  }
}
resource noLogin 'Microsoft.Web/sites/config@2023-12-01' = if (includeApplication) {
  parent: app
  name: 'authsettingsV2'
  properties: { platform: { enabled: false } }
}
resource ftpDisabled 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = if (includeApplication) {
  parent: app
  name: 'ftp'
  properties: { allow: false }
}
resource scmDisabled 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2023-12-01' = if (includeApplication) {
  parent: app
  name: 'scm'
  properties: { allow: false }
}
resource appLogs 'Microsoft.Web/sites/config@2023-12-01' = if (includeApplication) {
  parent: app
  name: 'logs'
  properties: {
    httpLogs: { fileSystem: { enabled: true, retentionInDays: 3, retentionInMb: 35 } }
    detailedErrorMessages: { enabled: false }
    failedRequestsTracing: { enabled: false }
  }
}
resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  name: 'friends-trivia-monthly'
  properties: {
    category: 'Cost'
    amount: budgetAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate, endDate: budgetEndDate }
    notifications: {
      actual80: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 80, thresholdType: 'Actual', contactEmails: empty(budgetEmail) ? [] : [budgetEmail], contactRoles: notifySubscriptionOwners ? ['Owner'] : [] }
      actual100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Actual', contactEmails: empty(budgetEmail) ? [] : [budgetEmail], contactRoles: notifySubscriptionOwners ? ['Owner'] : [] }
      forecast100: { enabled: true, operator: 'GreaterThanOrEqualTo', threshold: 100, thresholdType: 'Forecasted', contactEmails: empty(budgetEmail) ? [] : [budgetEmail], contactRoles: notifySubscriptionOwners ? ['Owner'] : [] }
    }
  }
}

output cosmosAccount string = cosmos.name
output cosmosAccountResourceId string = cosmos.id
output storageAccount string = storage.name
output appName string = includeApplication ? app!.name : ''
output defaultHostName string = includeApplication ? app!.properties.defaultHostName : ''
output publicUrl string = includeApplication ? 'https://${app!.properties.defaultHostName}' : ''
output runtimeIdentityName string = identities[0].name
output runtimeObjectId string = identities[0].properties.principalId
output runtimeClientId string = identities[0].properties.clientId
output deployIdentityName string = identities[1].name
output deployObjectId string = identities[1].properties.principalId
output deployClientId string = identities[1].properties.clientId
output testIdentityName string = identities[2].name
output testObjectId string = identities[2].properties.principalId
output testClientId string = identities[2].properties.clientId
output tenantId string = tenant().tenantId
output budgetStart string = budgetStartDate
output budgetEnd string = budgetEndDate
output productionEnvironment object = {
  FRIENDS_TRIVIA_MODE: 'cloud'
  COSMOS_ENDPOINT: cosmos.properties.documentEndpoint
  COSMOS_DATABASE: productionDatabase
  COSMOS_GAMES_CONTAINER: 'games'
  COSMOS_LIBRARY_CONTAINER: 'library'
  AZURE_STORAGE_ACCOUNT_URL: storage.properties.primaryEndpoints.blob
  AZURE_STORAGE_CONTAINER: songs.name
  AZURE_CLIENT_ID: identities[0].properties.clientId
  PUBLIC_URL: includeApplication ? 'https://${app!.properties.defaultHostName}' : ''
}
output testEnvironment object = {
  FRIENDS_TRIVIA_MODE: 'cloud'
  COSMOS_ENDPOINT: cosmos.properties.documentEndpoint
  COSMOS_DATABASE: testDatabase
  COSMOS_GAMES_CONTAINER: 'games'
  COSMOS_LIBRARY_CONTAINER: 'library'
  AZURE_STORAGE_ACCOUNT_URL: storage.properties.primaryEndpoints.blob
  AZURE_STORAGE_CONTAINER: testSongs.name
  AZURE_CLIENT_ID: identities[2].properties.clientId
  PUBLIC_URL: 'https://localhost'
  COSMOS_TEST_EXPECTED_ENDPOINT: cosmos.properties.documentEndpoint
  COSMOS_TEST_ACCOUNT_RESOURCE_ID: cosmos.id
  COSMOS_TEST_DATABASE: testDatabase
  AZURE_TEST_STORAGE_CONTAINER: testSongs.name
}
