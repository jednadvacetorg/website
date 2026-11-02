import { createError, deleteCookie, getCookie, getRequestHeader, getRequestURL, getRouterParam, setCookie, type H3Event } from 'h3'

const cookieName = '__Secure-notification-web-push'
// Do not send this capability to public pages, asset requests or the analytics proxy.
const cookieOptions = { httpOnly: true, secure: true, sameSite: 'strict' as const, path: '/api/notifications' }

/** One browser's Web Push capability; never exposed to client storage or analytics.
 * Retained for 90 days at most. Recovery rotates its authority; stop removes it.
 * The database checks the capability/generation on every read and mutation.
 */
export const rememberNotificationBrowser = (event: H3Event, token: string) => {
  setCookie(event, cookieName, token, { ...cookieOptions, maxAge: 90 * 24 * 60 * 60 })
}

export const forgetNotificationBrowser = (event: H3Event) => deleteCookie(event, cookieName, cookieOptions)

export const notificationManagementToken = (event: H3Event, mutation = false) => {
  const token = getRouterParam(event, 'token')
  if (token !== 'browser') return token
  // A cookie is ambient authority, unlike the explicit bearer URL. Reject
  // cross-origin mutations even when another origin is considered same-site.
  if (mutation && getRequestHeader(event, 'origin') !== getRequestURL(event).origin) {
    throw createError({ statusCode: 403, statusMessage: 'Notification management needs a same-origin request' })
  }
  return getCookie(event, cookieName)
}
