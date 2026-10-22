import { messages, ToolError } from '../errors.js'

const SERVICE_NAME = /^s-[a-z0-9]+(-[a-z0-9]+)*$/

export function checkService(service: string) {
  if (!SERVICE_NAME.test(service) || service.startsWith('s-consr-')) {
    throw new ToolError(messages.serviceNotAllowed(service))
  }
}
