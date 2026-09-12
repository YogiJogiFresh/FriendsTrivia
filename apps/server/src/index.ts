import 'dotenv/config'

import { buildApp } from './app.js'
import { config } from './config.js'
import { localNetworkUrls } from './network.js'

const { app } = await buildApp()
await app.listen({ host: config.host, port: config.port })

const urls = config.publicUrl ? [config.publicUrl] : localNetworkUrls(config.joinPort)
app.log.info({ urls }, 'FriendsTrivia is ready for local players')
