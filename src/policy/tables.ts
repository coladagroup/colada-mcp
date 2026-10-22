export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface RouteRule {
  id: string
  service: string
  method: Method
  pattern: RegExp
}

export const DELETE_DENYLIST: readonly RouteRule[] = [
  { id: 'D01', service: 's-events-guests', method: 'PATCH', pattern: /^\/api\/events\/[^/]+\/guests\/?$/ },
  { id: 'D02', service: 's-directory-locations', method: 'PATCH', pattern: /^\/api\/locations\/?$/ },
  { id: 'D03', service: 's-directory-accounts', method: 'PATCH', pattern: /^\/api\/accounts\/?$/ },
  { id: 'D04', service: 's-directory-contacts', method: 'PATCH', pattern: /^\/api\/contacts\/?$/ },
  { id: 'D05', service: 's-campaigns', method: 'PATCH', pattern: /^\/api\/campaigns\/?$/ },
  { id: 'D06', service: 's-email-templates', method: 'PATCH', pattern: /^\/api\/emailtemplates\/?$/ },
  { id: 'D07', service: 's-email-templates', method: 'PATCH', pattern: /^\/api\/events\/[^/]+\/emailtemplates\/?$/ },
  { id: 'D08', service: 's-events-guests', method: 'POST', pattern: /^\/api\/events\/[^/]+\/guests\/delete\/jobs\/?$/ },
  { id: 'D09', service: 's-directory-contacts', method: 'POST', pattern: /^\/api\/contacts\/delete\/jobs\/?$/ },
  { id: 'D10', service: 's-workspaces', method: 'POST', pattern: /^\/api\/admin\/workspaces\/jobs\/removal\/?$/ },
  {
    id: 'D11',
    service: 's-events-invoices',
    method: 'POST',
    pattern: /^\/api\/(events\/[^/]+\/)?guestsinvoices\/remove\/jobs\/?$/
  },
  { id: 'D12', service: 's-campaigns', method: 'GET', pattern: /^\/api\/campaigns\/[^/]+\/image\/delete\/?$/ },
  {
    id: 'D13',
    service: 's-events-mcontent-requests',
    method: 'GET',
    pattern: /^\/api\/events\/[^/]+\/mcontent\/requests\/[^/]+\/file\/delete\/url\/?$/
  },
  {
    id: 'D14',
    service: 's-events-invoices',
    method: 'POST',
    pattern: /^\/api\/events\/[^/]+\/brokersinvoices\/remove\/jobs\/?$/
  }
]

export const DELETE_ALLOWLIST: readonly RouteRule[] = []

export const SECRET_ROUTES: readonly RouteRule[] = [
  { id: 'S01', service: 's-workspaces', method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/smtp\/?$/ },
  { id: 'S02', service: 's-workspaces', method: 'PUT', pattern: /^\/api\/workspaces\/[^/]+\/smtp\/?$/ },
  { id: 'S03', service: 's-licenses', method: 'GET', pattern: /^\/api\/stripe\/billing-portal\/?$/ },
  { id: 'S04', service: 's-campaigns-integration', method: 'GET', pattern: /^\/api\/stripe\/settings\/?$/ },
  { id: 'S05', service: 's-campaigns-integration', method: 'PUT', pattern: /^\/api\/stripe\/settings\/?$/ },
  { id: 'S06', service: 's-campaigns-integration', method: 'POST', pattern: /^\/api\/stripe\/payment-links\/?$/ },
  { id: 'S07', service: 's-access', method: 'POST', pattern: /^\/api\/auth\/integrations\/[^/]+\/firebase\/token\/?$/ },
  { id: 'S11', service: 's-access', method: 'PUT', pattern: /^\/api\/users\/[^/]+\/reset-otp\/?$/ },
  {
    id: 'S12',
    service: 's-directory-contacts',
    method: 'PUT',
    pattern: /^\/api\/contacts\/[^/]+\/password\/reset\/?$/
  },
  { id: 'S13', service: 's-workspaces', method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/smtp-with-creds\/?$/ },
  { id: 'S14', service: 's-workspaces', method: 'PUT', pattern: /^\/api\/admin\/workspaces\/[^/]+\/stripe\/?$/ },
  { id: 'S15', service: 's-licenses', method: 'PUT', pattern: /^\/api\/stripe\/checkout\/[^/]+\/expired\/?$/ }
]

export const PERSONAL_DATA_SERVICES: readonly string[] = [
  's-events-guests',
  's-events-guests-bookings',
  's-events-guests-changelog',
  's-events-guests-importpln',
  's-events-guests-exportpln',
  's-directory-contacts',
  's-directory-contacts-importpln',
  's-directory-contacts-exportpln',
  's-contacts-time-slots',
  's-access',
  's-speakers',
  's-speakers-contracts',
  's-speakers-engagements',
  's-speakers-requests',
  's-speakers-scoring-profiles',
  's-speakers-requests-newscaster',
  's-events-invoices',
  's-events-payments',
  's-guest-nominations',
  's-assistant-scanner',
  's-printers',
  's-emailcomposer',
  's-email-logger',
  's-notifications',
  's-newscaster',
  's-newscaster-scheduler',
  's-events-mcontent-requests',
  's-events-brokers',
  's-events-registration',
  's-guests-checker'
]

export const PERSONAL_DATA_ROUTE_ALLOWLIST: readonly RouteRule[] = [
  { id: 'A01', service: 's-documents', method: 'GET', pattern: /^\/api\/events\/[^/]+\/documents\/templates$/ },
  { id: 'A02', service: 's-documents', method: 'GET', pattern: /^\/api\/events\/[^/]+\/documents\/templates\/[^/]+$/ },
  {
    id: 'A03',
    service: 's-documents',
    method: 'POST',
    pattern: /^\/api\/events\/[^/]+\/documents\/(ticket|badge|icalendar|wallet-pass)\/templates$/
  },
  { id: 'A04', service: 's-documents', method: 'PUT', pattern: /^\/api\/events\/[^/]+\/documents\/templates\/[^/]+$/ },
  {
    id: 'A05',
    service: 's-documents',
    method: 'PUT',
    pattern: /^\/api\/events\/[^/]+\/documents\/templates\/[^/]+\/copied$/
  },
  {
    id: 'A06',
    service: 's-documents',
    method: 'GET',
    pattern: /^\/api\/events\/[^/]+\/documents\/templates\/settings$/
  },
  {
    id: 'A07',
    service: 's-documents',
    method: 'PUT',
    pattern: /^\/api\/events\/[^/]+\/documents\/templates\/settings$/
  },
  { id: 'A08', service: 's-documents', method: 'PUT', pattern: /^\/api\/documenttemplates\/fonts\/files$/ },
  { id: 'A09', service: 's-documents', method: 'GET', pattern: /^\/api\/documenttemplates\/fonts\/files\/[^/]+$/ },
  { id: 'A10', service: 's-documents', method: 'PUT', pattern: /^\/api\/documenttemplates\/files$/ },
  { id: 'A11', service: 's-documents', method: 'GET', pattern: /^\/api\/documenttemplates\/files\/[^/]+$/ },
  {
    id: 'A12',
    service: 's-file-storage',
    method: 'PUT',
    pattern:
      /^\/api\/public-files\/(events\/[^/]+\/)?(emailtemplates|designer|assets|pages|agenda|games|dashboards|notifications|announcements|documentation|consumer-portal|form-templates\/registration)(\/.+)?\/upload\/url$/
  },
  {
    id: 'A13',
    service: 's-file-storage',
    method: 'PUT',
    pattern: /^\/api\/files\/(events\/[^/]+\/)?emailtemplates\/[^/]+\/attachments(\/.+)?\/upload\/url$/
  },
  {
    id: 'A14',
    service: 's-file-storage',
    method: 'GET',
    pattern: /^\/api\/files\/(designer|assets|pages|events\/[^/]+\/pages)\/.+\/download\/url$/
  },
  { id: 'A15', service: 's-directory-accounts', method: 'GET', pattern: /^\/api\/accounts\/count$/ },
  { id: 'A16', service: 's-directory-accounts', method: 'GET', pattern: /^\/api\/accounts\/projections$/ },
  { id: 'A17', service: 's-workspaces', method: 'GET', pattern: /^\/api\/workspaces$/ },
  { id: 'A18', service: 's-workspaces', method: 'GET', pattern: /^\/api\/workspaces\/[^/]+$/ },
  {
    id: 'A19',
    service: 's-workspaces',
    method: 'GET',
    pattern: /^\/api\/workspaces\/[^/]+\/(currencies|vat-rates|languages)$/
  },
  {
    id: 'A20',
    service: 's-workspaces',
    method: 'PUT',
    pattern: /^\/api\/workspaces\/[^/]+\/(currencies|vat-rates|languages)$/
  },
  { id: 'A21', service: 's-workspaces', method: 'GET', pattern: /^\/api\/workspaces\/[^/]+\/featuretoggles(\/my)?$/ },
  { id: 'A22', service: 's-workspaces', method: 'GET', pattern: /^\/api\/constants$/ },
  { id: 'A23', service: 's-workspaces', method: 'PUT', pattern: /^\/api\/constants$/ },
  { id: 'A24', service: 's-workspaces', method: 'GET', pattern: /^\/api\/admin\/workspaces\/featuretoggles$/ },
  { id: 'A25', service: 's-workspaces', method: 'GET', pattern: /^\/api\/admin\/workspaces\/[^/]+\/featuretoggles$/ },
  { id: 'A26', service: 's-workspaces', method: 'GET', pattern: /^\/api\/admin\/workspaces\/jobs\/[^/]+\/status$/ },
  { id: 'A27', service: 's-workspaces', method: 'PUT', pattern: /^\/api\/admin\/workspaces\/[^/]+\/featuretoggles$/ },
  { id: 'A28', service: 's-licenses', method: 'GET', pattern: /^\/api\/licenses(\/(?!items$)[^/]+)?$/ },
  { id: 'A29', service: 's-licenses', method: 'GET', pattern: /^\/api\/licenses\/items\/cost$/ },
  { id: 'A30', service: 's-licenses', method: 'GET', pattern: /^\/api\/licenses\/features\/my$/ },
  { id: 'A31', service: 's-licenses', method: 'GET', pattern: /^\/api\/applications$/ },
  { id: 'A32', service: 's-licenses', method: 'GET', pattern: /^\/api\/admin\/workspaces\/[^/]+\/licenses(\/[^/]+)?$/ },
  { id: 'A33', service: 's-licenses', method: 'POST', pattern: /^\/api\/licensesinvoices\/purchase\/cost$/ },
  {
    id: 'A34',
    service: 's-licenses',
    method: 'GET',
    pattern: /^\/api\/licensesinvoices\/generate\/jobs\/[^/]+\/status$/
  },
  { id: 'A35', service: 's-licenses', method: 'GET', pattern: /^\/api\/subscriptions$/ },
  { id: 'A36', service: 's-licenses', method: 'GET', pattern: /^\/api\/admin\/workspaces\/[^/]+\/subscriptions$/ },
  { id: 'A37', service: 's-licenses', method: 'POST', pattern: /^\/api\/subscriptions\/trial-end-date$/ },
  { id: 'A38', service: 's-licenses', method: 'GET', pattern: /^\/api\/transactions$/ },
  { id: 'A39', service: 's-licenses', method: 'GET', pattern: /^\/api\/admin\/reporting\/jobs\/[^/]+\/status$/ },
  { id: 'A40', service: 's-licenses', method: 'PUT', pattern: /^\/api\/admin\/workspaces\/[^/]+\/licenses\/[^/]+$/ },
  { id: 'A41', service: 's-licenses', method: 'POST', pattern: /^\/api\/admin\/applications\/predefined\/copy$/ },
  { id: 'A42', service: 's-licenses', method: 'POST', pattern: /^\/api\/admin\/licenses\/predefined\/copy$/ },
  {
    id: 'A43',
    service: 's-orgstructure',
    method: 'PUT',
    pattern: /^\/api\/orgstructure\/departments\/[^/]+\/children\/[^/]+$/
  },
  { id: 'A44', service: 's-orgstructure', method: 'GET', pattern: /^\/api\/orgstructure\/users\/me\/departments$/ },
  {
    id: 'A45',
    service: 's-orgstructure',
    method: 'GET',
    pattern:
      /^\/api\/orgstructure\/(campaigns\/[^/]+|campaigns\/[^/]+\/events\/[^/]+|events\/[^/]+|guidelines\/[^/]+)\/departments$/
  },
  {
    id: 'A46',
    service: 's-orgstructure',
    method: 'PUT',
    pattern:
      /^\/api\/orgstructure\/(campaigns\/[^/]+|campaigns\/[^/]+\/events\/[^/]+|events\/[^/]+|guidelines\/[^/]+)\/departments$/
  },
  { id: 'A47', service: 's-orgstructure', method: 'GET', pattern: /^\/api\/orgstructure\/users\/[^/]+\/departments$/ },
  {
    id: 'A48',
    service: 's-consumer-portal-admin',
    method: 'GET',
    pattern: /^\/api\/consumerportal\/pages(\/[^/]+(\/children)?)?$/
  },
  {
    id: 'A49',
    service: 's-consumer-portal-admin',
    method: 'POST',
    pattern: /^\/api\/consumerportal\/pages(\/[^/]+\/children)?$/
  },
  {
    id: 'A50',
    service: 's-consumer-portal-admin',
    method: 'PUT',
    pattern: /^\/api\/consumerportal\/pages\/[^/]+\/(details|content|rank)$/
  },
  {
    id: 'A51',
    service: 's-consumer-portal-admin',
    method: 'POST',
    pattern: /^\/api\/consumerportal\/pages\/[^/]+\/files\/[^/]+$/
  },
  {
    id: 'A52',
    service: 's-consumer-portal-admin',
    method: 'PUT',
    pattern: /^\/api\/consumerportal\/pages\/[^/]+\/(published|unpublished)$/
  },
  {
    id: 'A53',
    service: 's-events-resources-inventory',
    method: 'GET',
    pattern: /^\/api\/events\/[^/]+\/resources\/rn_[^/]+\/slotschema$/
  },
  {
    id: 'A54',
    service: 's-events-resources-inventory',
    method: 'POST',
    pattern: /^\/api\/events\/[^/]+\/resources\/rn_[^/]+\/slots\/indexing\/jobs$/
  },
  {
    id: 'A55',
    service: 's-events-resources-inventory',
    method: 'GET',
    pattern: /^\/api\/events\/[^/]+\/resources\/rn_[^/]+\/slots\/indexing\/jobs\/[^/]+\/status$/
  }
]
