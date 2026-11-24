// Satu-satunya tugas: HTTP dialihkan ke HTTPS. Selain itu aset dilayani apa adanya (termasuk _headers).
export default {
  fetch(request, env) {
    const url = new URL(request.url)
    if (url.protocol === 'http:') {
      url.protocol = 'https:'
      return Response.redirect(url.toString(), 301)
    }
    return env.ASSETS.fetch(request)
  },
}
