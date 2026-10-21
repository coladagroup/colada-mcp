import { AsyncEntry } from '@napi-rs/keyring'

const SERVICE = 'colada-mcp'

export interface TokenStore {
  get(account: string): Promise<string | null>
  set(account: string, value: string): Promise<void>
  delete(account: string): Promise<void>
}

export const keyringStore: TokenStore = {
  get: (account) => new AsyncEntry(SERVICE, account).getPassword(),
  set: (account, value) => new AsyncEntry(SERVICE, account).setPassword(value),
  delete: async (account) => {
    await new AsyncEntry(SERVICE, account).deleteCredential()
  }
}
