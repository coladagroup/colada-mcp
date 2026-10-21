import { messages, ToolError } from '../errors.js'

const UUID_FORM = /^\w{8}-\w{4}-\w{4}-\w{4}-\w{12}$/
const OBJECT_ID_FORM = /^\w{24}$/

export function checkEventId(value: string) {
  if (!OBJECT_ID_FORM.test(value) && !UUID_FORM.test(value)) throw new ToolError(messages.invalidId('eventId', value))
}

export function checkUuid(field: string, value: string) {
  if (!UUID_FORM.test(value)) throw new ToolError(messages.invalidId(field, value))
}
