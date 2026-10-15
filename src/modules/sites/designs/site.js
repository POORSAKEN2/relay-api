// Footer year, the phone menu, the phone call/book dock, and the sun-cast
// fallback for browsers without scroll-driven animations.

const year = document.querySelector('[data-year]')
if (year) year.textContent = String(new Date().getFullYear())

// Phone menu
const menuButton = document.querySelector('[data-menu-button]')
const nav = document.getElementById('site-nav')

function setMenu(open) {
  menuButton.setAttribute('aria-expanded', String(open))
  nav.classList.toggle('is-open', open)
}

if (menuButton && nav) {
  menuButton.addEventListener('click', () => {
    setMenu(menuButton.getAttribute('aria-expanded') !== 'true')
  })
  nav.addEventListener('click', (event) => {
    if (event.target.closest('a')) setMenu(false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && nav.classList.contains('is-open')) {
      setMenu(false)
      menuButton.focus()
    }
  })
}

// The dock shows once the page's own Book/Call buttons are off screen.
const dock = document.querySelector('.dock')
const watched = document.querySelectorAll('[data-watch-actions]')

if (dock && watched.length && 'IntersectionObserver' in window) {
  const visible = new Set()
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target)
      else visible.delete(entry.target)
    }
    dock.classList.toggle('is-shown', visible.size === 0)
  })
  for (const el of watched) observer.observe(el)
} else if (dock) {
  dock.classList.add('is-shown')
}

// Sun cast: CSS drives it with a view timeline where supported; otherwise
// follow the same progress (section entering to section leaving) here.
const casts = document.querySelectorAll('[data-cast]')
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
const hasViewTimeline = window.CSS && CSS.supports('animation-timeline', 'view()')

if (casts.length && !hasViewTimeline && !reduceMotion.matches) {
  let queued = false

  const update = () => {
    queued = false
    const viewport = window.innerHeight
    for (const cast of casts) {
      const box = cast.parentElement.getBoundingClientRect()
      const progress = Math.min(1, Math.max(0, (viewport - box.top) / (viewport + box.height)))
      const skew = -38 + 56 * progress
      const shift = -7 + 14 * progress
      cast.style.transform = `skewX(${skew}deg) scaleY(0.72) translateX(${shift}%)`
    }
  }

  window.addEventListener(
    'scroll',
    () => {
      if (!queued) {
        queued = true
        requestAnimationFrame(update)
      }
    },
    { passive: true },
  )
  update()
}
