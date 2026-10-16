/* global document, localStorage, matchMedia */
// Runs before the first paint (a classic script in each app's index.html; both
// apps serve this folder as Vite's publicDir). It applies the stored theme,
// style and interface size the way appearance.ts does (boot.test.ts checks
// they agree), so a page never paints in the default light colors before its
// bundle runs, and the boot screen in #root shows in the user's theme.
;(function () {
  var root = document.documentElement
  function read(key) {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  }
  var themes = ["light", "dark", "dark-purple", "dark-brown", "beige", "light-brown"]
  var theme = read("panelyth.theme")
  if (theme === "system") {
    theme = matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  if (themes.indexOf(theme) < 0) theme = "dark"
  root.classList.toggle("dark", theme.indexOf("dark") === 0)
  root.dataset.theme = theme
  root.dataset.style = read("panelyth.style") === "glass" ? "glass" : "classic"
  var size = read("panelyth.interfaceSize")
  root.dataset.interfaceSize =
    ["small", "medium", "large", "xlarge"].indexOf(size) >= 0 ? size : "medium"
})()
