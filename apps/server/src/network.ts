import os from 'node:os'

export function localNetworkUrls(port: number): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(
      (address): address is os.NetworkInterfaceInfo =>
        Boolean(
          address &&
            address.family === 'IPv4' &&
            !address.internal &&
            isPrivateAddress(address.address),
        ),
    )
    .map((address) => address.address)
    .sort((left, right) => privateAddressPriority(left) - privateAddressPriority(right))
    .map((address) => `http://${address}:${port}`)
}

function privateAddressPriority(address: string): number {
  if (address.startsWith('192.168.')) return 0
  if (address.startsWith('172.')) return 1
  return 2
}

export function preferredJoinBaseUrl(publicUrl: string | undefined, port: number): string {
  return publicUrl ?? localNetworkUrls(port)[0] ?? `http://localhost:${port}`
}

function isPrivateAddress(address: string): boolean {
  if (address.startsWith('10.') || address.startsWith('192.168.')) return true
  const match = /^172\.(\d+)\./.exec(address)
  return match ? Number(match[1]) >= 16 && Number(match[1]) <= 31 : false
}
