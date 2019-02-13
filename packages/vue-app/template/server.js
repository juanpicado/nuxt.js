import { stringify } from 'querystring'
import Vue from 'vue'
import middleware from './middleware.js'
import { applyAsyncData, getMatchedComponents, middlewareSeries, promisify, urlJoin, sanitizeComponent } from './utils.js'
import asyncDataMixin from './mixins/async-data.server'
import fetchMixin from './mixins/fetch.server'
import { createApp, NuxtError } from './index.js'
import NuxtLink from './components/nuxt-link.server.js' // should be included after ./index.js

// Update serverPrefetch strategy
Vue.config.optionMergeStrategies.serverPrefetch = Vue.config.optionMergeStrategies.created

// Async Data & fetch mixin
Vue.mixin(asyncDataMixin)
Vue.mixin(fetchMixin)

// Component: <NuxtLink>
Vue.component(NuxtLink.name, NuxtLink)
Vue.component('NLink', NuxtLink)

const debug = require('debug')('nuxt:render')
debug.color = 4 // force blue color

const noopApp = () => new Vue({ render: h => h('div') })

const createNext = ssrContext => (opts) => {
  ssrContext.redirected = opts
  // If nuxt generate
  if (!ssrContext.res) {
    ssrContext.nuxt.serverRendered = false
    return
  }
  opts.query = stringify(opts.query)
  opts.path = opts.path + (opts.query ? '?' + opts.query : '')
  const routerBase = '<%= router.base %>'
  if (!opts.path.startsWith('http') && (routerBase !== '/' && !opts.path.startsWith(routerBase))) {
    opts.path = urlJoin(routerBase, opts.path)
  }
  // Avoid loop redirect
  if (opts.path === ssrContext.url) {
    ssrContext.redirected = false
    return
  }
  ssrContext.res.writeHead(opts.status, {
    'Location': opts.path
  })
  ssrContext.res.end()
}

// This exported function will be called by `bundleRenderer`.
// This is where we perform data-prefetching to determine the
// state of our application before actually rendering it.
// Since data fetching is async, this function is expected to
// return a Promise that resolves to the app instance.
export default async (ssrContext) => {
  // Create ssrContext.next for simulate next() of beforeEach() when wanted to redirect
  ssrContext.redirected = false
  ssrContext.next = createNext(ssrContext)
  // Used for beforeNuxtRender({ Components, nuxtState })
  ssrContext.beforeRenderFns = []
  // Nuxt object (window{{globals.context}}, defaults to window.__NUXT__)
  ssrContext.nuxt = { layout: 'default', data: [], error: null<%= (store ? ', state: null' : '') %>, serverRendered: true }
  // Create the app definition and the instance (created for each request)
  const { app, router<%= (store ? ', store' : '') %> } = await createApp(ssrContext)
  const _app = new Vue(app)

  // Add meta infos (used in renderer.js)
  ssrContext.meta = _app.$meta()
  // Keep asyncData for each matched component in ssrContext (used in app/utils.js via this.$ssrContext)
  ssrContext.asyncData = {}

  const beforeRender = async () => {
    // Call beforeNuxtRender() methods
    await Promise.all(ssrContext.beforeRenderFns.map(fn => promisify(fn, { Components, nuxtState: ssrContext.nuxt })))
    <% if (store) { %>
    // Add the state from the vuex store
    ssrContext.nuxt.state = store.state
    <% } %>
  }
  const renderErrorPage = async () => {
    // Load layout for error page
    const errLayout = (typeof NuxtError.layout === 'function' ? NuxtError.layout(app.context) : NuxtError.layout)
    ssrContext.nuxt.layout = errLayout || 'default'
    await _app.loadLayout(errLayout)
    _app.setLayout(errLayout)
    await beforeRender()
    return _app
  }
  const render404Page = () => {
    app.context.error({ statusCode: 404, path: ssrContext.url, message: `<%= messages.error_404 %>` })
    return renderErrorPage()
  }

  <% if (isDev) { %>const s = Date.now()<% } %>

  // Components are already resolved by setContext -> getRouteData (app/utils.js)
  const Components = getMatchedComponents(router.match(ssrContext.url))

  <% if (store) { %>
  /*
  ** Dispatch store nuxtServerInit
  */
  if (store._actions && store._actions.nuxtServerInit) {
    try {
      await store.dispatch('nuxtServerInit', app.context)
    } catch (err) {
      debug('error occurred when calling nuxtServerInit: ', err.message)
      throw err
    }
  }
  // ...If there is a redirect or an error, stop the process
  if (ssrContext.redirected) return noopApp()
  if (ssrContext.nuxt.error) return renderErrorPage()
  <% } %>

  /*
  ** Call global middleware (nuxt.config.js)
  */
  let midd = <%= serialize(router.middleware).replace('middleware(', 'function(') %><%= isTest ? '// eslint-disable-line' : '' %>
  midd = midd.map((name) => {
    if (typeof name === 'function') return name
    if (typeof middleware[name] !== 'function') {
      app.context.error({ statusCode: 500, message: 'Unknown middleware ' + name })
    }
    return middleware[name]
  })
  await middlewareSeries(midd, app.context)
  // ...If there is a redirect or an error, stop the process
  if (ssrContext.redirected) return noopApp()
  if (ssrContext.nuxt.error) return renderErrorPage()

  /*
  ** Set layout
  */
  let layout = Components.length ? Components[0].options.layout : NuxtError.layout
  if (typeof layout === 'function') layout = layout(app.context)
  await _app.loadLayout(layout)
  if (ssrContext.nuxt.error) return renderErrorPage()
  layout = _app.setLayout(layout)
  ssrContext.nuxt.layout = _app.layoutName

  /*
  ** Call middleware (layout + pages)
  */
  midd = []
  layout = sanitizeComponent(layout)
  if (layout.options.middleware) midd = midd.concat(layout.options.middleware)
  Components.forEach((Component) => {
    if (Component.options.middleware) {
      midd = midd.concat(Component.options.middleware)
    }
  })
  midd = midd.map((name) => {
    if (typeof name === 'function') return name
    if (typeof middleware[name] !== 'function') {
      app.context.error({ statusCode: 500, message: 'Unknown middleware ' + name })
    }
    return middleware[name]
  })
  await middlewareSeries(midd, app.context)
  // ...If there is a redirect or an error, stop the process
  if (ssrContext.redirected) return noopApp()
  if (ssrContext.nuxt.error) return renderErrorPage()

  /*
  ** Call .validate()
  */
  let isValid = true
  try {
    for (const Component of Components) {
      if (typeof Component.options.validate !== 'function') {
        continue
      }

      isValid = await Component.options.validate(app.context)

      if (!isValid) {
        break
      }
    }
  } catch (validationError) {
    // ...If .validate() threw an error
    app.context.error({
      statusCode: validationError.statusCode || '500',
      message: validationError.message
    })
    return renderErrorPage()
  }

  // ...If .validate() returned false
  if (!isValid) {
    // Don't server-render the page in generate mode
    if (ssrContext._generate) ssrContext.nuxt.serverRendered = false
    // Render a 404 error page
    return render404Page()
  }

  // If no Components found, returns 404
  if (!Components.length) return render404Page()

  // <% if (isDev) { %>if (asyncDatas.length) debug('Data fetching ' + ssrContext.url + ': ' + (Date.now() - s) + 'ms')<% } %>

  // datas are the first row of each
  ssrContext.nuxt.data = ssrContext.asyncData

  // ...If there is a redirect or an error, stop the process
  if (ssrContext.redirected) return noopApp()
  if (ssrContext.nuxt.error) return renderErrorPage()

  // Call beforeNuxtRender methods & add store state
  await beforeRender()

  return _app
}
