import Ext from '@/common/web_extension'
import { isSidePanelWindow } from '@/common/utils'

// go.ui.vision help links carry which interface they came from plus the
// extension version — the redirect worker logs these and the /report page
// splits the counts by gui=sidebar|ide|settings (settings = the shared
// options.html page, which any surface may have opened).
//
// Pass `gui` to override that guess. The background opens three pages nobody
// clicked (install, upgrade, uninstall) and passes 'bg': in a service worker
// isSidePanelWindow() has no window to look at and answers false, so those
// would otherwise report as 'ide' and inflate exactly the split this measures.
export function goUivUrl (url: string, gui?: string): string {
  try {
    if (!/^https:\/\/go\.ui\.vision\//.test(url)) return url
    if (/[?&]gui=/.test(url)) return url

    const onSettingsPage = typeof window !== 'undefined' && window.location.pathname.includes('options.html')
    const gui_ = gui || (isSidePanelWindow() ? 'sidebar' : onSettingsPage ? 'settings' : 'ide')
    const version = Ext.runtime.getManifest().version
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}gui=${gui_}&version=${encodeURIComponent(version)}`
  } catch (e) {
    return url
  }
}

// Chat-completions URL for an OpenAI-compatible endpoint. Calls to the
// Ui.Vision free-tier proxy (ai.ui.vision) additionally carry gui=sidebar|ide
// and the extension version, so the server logs show which interface the AI
// chat is used from. Other providers (OpenRouter, local) get the plain URL.
export function chatCompletionsUrl (baseURL: string): string {
  // tolerate a pasted baseURL that already ends in /chat/completions
  const trimmed = String(baseURL || '').replace(/\/+$/, '')
  const url = /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
  try {
    if (!/\bai\.ui\.vision\b/i.test(baseURL)) return url

    const gui = isSidePanelWindow() ? 'sidebar' : 'ide'
    const version = Ext.runtime.getManifest().version
    return `${url}?gui=${gui}&version=${encodeURIComponent(version)}`
  } catch (e) {
    return url
  }
}

// Tag every <a href="https://go.ui.vision/..."> at click time (capture phase
// runs before the browser follows the link), so the ~80 literal hrefs across
// the app don't need touching — and future links get tagged automatically.
// Programmatic opens (chrome.tabs.create / window.open) bypass this and wrap
// their url in goUivUrl() at the call site.
export function installGoUivLinkDecorator (): void {
  document.addEventListener(
    'click',
    (e: MouseEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || !target.closest) return

      const anchor = target.closest('a[href*="go.ui.vision"]') as HTMLAnchorElement | null
      if (!anchor) return

      const href = anchor.getAttribute('href')
      if (!href) return

      anchor.setAttribute('href', goUivUrl(href))
    },
    true
  )
}

/**
 * Safely parses chat completion response, handling both standard JSON responses
 * and Server-Sent Events (SSE) streaming format (data: {...}) when servers or proxies
 * stream responses despite stream: false.
 */
export async function parseChatCompletionResponse (res: Response): Promise<any> {
  const text = await res.text()
  const trimmed = text.trim()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed)
    } catch (e) {
      // Fall through to SSE / raw handling if parse fails
    }
  }

  if (trimmed.includes('data:')) {
    const lines = text.split(/\r?\n/)
    let combinedContent = ''
    const toolCallsMap: Record<number, any> = {}
    let lastModel = ''
    let lastId = ''
    let usage: any = null
    let singleMessage: any = null

    for (const line of lines) {
      const lineTrim = line.trim()
      if (!lineTrim.startsWith('data:')) continue
      const dataStr = lineTrim.slice(5).trim()
      if (!dataStr || dataStr === '[DONE]') continue

      try {
        const parsed = JSON.parse(dataStr)
        if (parsed.id) lastId = parsed.id
        if (parsed.model) lastModel = parsed.model
        if (parsed.usage) usage = parsed.usage

        const choice = parsed.choices?.[0]
        if (!choice) continue

        if (choice.message) {
          singleMessage = choice.message
          continue
        }

        const delta = choice.delta
        if (!delta) continue

        if (typeof delta.content === 'string') {
          combinedContent += delta.content
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0
            if (!toolCallsMap[idx]) {
              toolCallsMap[idx] = {
                id: tc.id || `call_${idx}`,
                type: tc.type || 'function',
                function: {
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || ''
                }
              }
            } else {
              if (tc.id) toolCallsMap[idx].id = tc.id
              if (tc.type) toolCallsMap[idx].type = tc.type
              if (tc.function?.name) toolCallsMap[idx].function.name += tc.function.name
              if (tc.function?.arguments) toolCallsMap[idx].function.arguments += tc.function.arguments
            }
          }
        }
      } catch (err) {
        // ignore unparseable chunk
      }
    }

    const toolCalls = Object.values(toolCallsMap)
    return {
      id: lastId,
      model: lastModel,
      usage,
      choices: [
        {
          message: singleMessage || {
            role: 'assistant',
            content: combinedContent || null,
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
          }
        }
      ]
    }
  }

  return JSON.parse(text)
}
