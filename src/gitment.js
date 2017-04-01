import { autorun, observable } from 'mobx'

import { LS_ACCESS_TOKEN_KEY, LS_USER_KEY, NOT_INITIALIZED_ERROR } from './constants'
import { getTargetContainer, http, Query } from './utils'
import defaultTheme from './theme/default'

const scope = 'repo'

function extendRenderer(instance, renderer) {
  instance[renderer] = (container) => {
    const targetContainer = getTargetContainer(container)
    const render = instance.theme[renderer] || instance.defaultTheme[renderer]

    autorun(() => {
      const e = render(instance.state, instance)
      if (targetContainer.firstChild) {
        targetContainer.replaceChild(e, targetContainer.firstChild)
      } else {
        targetContainer.appendChild(e)
      }
    })

    return targetContainer
  }
}

class Gitment {
  get accessToken() {
    return localStorage.getItem(LS_ACCESS_TOKEN_KEY)
  }
  set accessToken(token) {
    localStorage.setItem(LS_ACCESS_TOKEN_KEY, token)
  }

  get loginLink() {
    const oauthUri = 'https://github.com/login/oauth/authorize'
    const redirect_uri = this.oauth.redirect_uri || window.location.href

    const oauthParams = Object.assign({
      scope,
      redirect_uri,
    }, this.oauth)

    return `${oauthUri}${Query.stringify(oauthParams)}`
  }

  constructor(options = {}) {
    this.defaultTheme = defaultTheme
    this.useTheme(defaultTheme)

    Object.assign(this, {
      id: window.location.href,
      title: window.document.title,
      link: window.location.href,
      desc: '',
      labels: [],
      theme: defaultTheme,
      oauth: {},
      perPage: 30,
    }, options)

    this.useTheme(this.theme)

    const user = {}
    try {
      const userInfo = localStorage.getItem(LS_USER_KEY)
      if (this.accessToken && userInfo) {
        Object.assign(user, JSON.parse(userInfo), {
          fromCache: true,
        })
      }
    } catch (e) {
      localStorage.removeItem(LS_USER_KEY)
    }

    this.state = observable({
      user,
      error: null,
      meta: {},
      comments: undefined,
      reactions: [],
      currentPage: 1,
    })

    const query = Query.parse()
    if (query.code) {
      const { client_id, client_secret } = this.oauth
      const code = query.code
      delete query.code
      const search = Query.stringify(query)
      const replacedUrl = `${window.location.origin}${window.location.pathname}${search}${window.location.hash}`
      history.replaceState({}, '', replacedUrl)

      Object.assign(this, {
        id: replacedUrl,
        link: replacedUrl,
      }, options)

      this.state.user.loginning = true
      http.post('https://gh-oauth.imsun.net', {
          code,
          client_id,
          client_secret,
        }, '')
        .then(data => {
          this.accessToken = data.access_token
          this.update()
        })
        .catch(e => {
          this.user.loginning = false
          alert(e)
        })
    } else {
      this.update()
    }
  }

  init() {
    return this.createIssue()
      .then(() => this.loadComments())
      .then(comments => {
        this.state.error = null
        return comments
      })
  }

  useTheme(theme = {}) {
    this.theme = theme

    const renderers = Object.keys(this.theme)
    renderers.forEach(renderer => extendRenderer(this, renderer))
  }

  update() {
    return Promise.all([this.loadMeta(), this.loadUserInfo()])
      .then(() => Promise.all([this.loadComments(), this.loadReactions()]))
      .catch(e => this.state.error = e)
  }

  markdown(text) {
    return http.post('/markdown', {
      text,
      mode: 'gfm',
    })
  }

  createIssue() {
    const { id, owner, repo, title, link, desc, labels } = this

    return http.post(`/repos/${owner}/${repo}/issues`, {
      title,
      labels: labels.concat(['gitment', id]),
      body: `${link}\n\n${desc}`,
    })
      .then((meta) => {
        this.state.meta = meta
        return meta
      })
  }

  getIssue() {
    if (this.state.meta.id) return Promise.resolve(this.state.meta)

    return this.loadMeta()
  }

  post(body) {
    return this.getIssue()
      .then(issue => http.post(issue.comments_url, { body }, ''))
  }

  loadMeta() {
    const { id, owner, repo } = this
    return http.get(`/repos/${owner}/${repo}/issues`, {
        creator: owner,
        labels: id,
      })
      .then(issues => {
        if (!issues.length) return Promise.reject(NOT_INITIALIZED_ERROR)
        this.state.meta = issues[0]
        return issues[0]
      })
  }

  loadComments(page = this.state.currentPage) {
    return this.getIssue()
      .then(issue => http.get(issue.comments_url, { page, per_page: this.perPage }, ''))
      .then((comments) => {
        this.state.comments = comments
        return comments
      })
  }

  loadUserInfo() {
    if (!this.accessToken) {
      this.logout()
      return Promise.resolve({})
    }

    const { owner, repo } = this

    return http.get('/user')
      .then(user => {
        return http.get(`/repos/${owner}/${repo}/collaborators/${user.login}/permission`)
          .then(permission => Object.assign(user, { permission: permission.permission }))
      })
      .then((user) => {
        this.state.user = user
        localStorage.setItem(LS_USER_KEY, JSON.stringify(user))
        return user
      })
  }

  loadReactions() {
    if (!this.accessToken) return Promise.resolve([])

    return this.getIssue()
      .then((issue) => {
        if (!issue.reactions.heart) return []
        return http.get(issue.reactions.url, { content: 'heart' }, '')
      })
      .then((reactions) => {
        this.state.reactions = reactions
        return reactions
      })
  }

  login() {
    window.location.href = this.loginLink
  }

  logout() {
    localStorage.removeItem(LS_ACCESS_TOKEN_KEY)
    localStorage.removeItem(LS_USER_KEY)
    this.state.user = {}
  }

  goto(page) {
    this.state.currentPage = page
    this.state.comments = undefined
    return this.loadComments(page)
  }

  like() {
    if (!this.accessToken) {
      alert('Login to Like')
      return Promise.reject()
    }

    const { owner, repo } = this

    return http.post(`/repos/${owner}/${repo}/issues/${this.state.meta.number}/reactions`, {
      content: 'heart',
    })
      .then(reaction => {
        this.state.reactions.push(reaction)
        this.state.meta.reactions.heart++
      })
  }

  unlike() {
    if (!this.accessToken) return Promise.reject()


    const { user, reactions } = this.state
    const index = reactions.findIndex(reaction => reaction.user.login === user.login)
    return http.delete(`/reactions/${reactions[index].id}`)
      .then(() => {
        reactions.splice(index, 1)
        this.state.meta.reactions.heart--
      })
  }
}

module.exports = Gitment
