const pillEl = document.getElementById('pill')
const dropdown = document.getElementById('dropdown')
const disableLabel = document.getElementById('disable-label')
let menuOpen = false

const PAD = 6 // 与 toolbar.css body padding 保持一致
const HPAD = 8

// 把内容实际尺寸回报给主进程，窗口严格贴合内容（无空白、阴影不被裁切）
function reportFit() {
  const dd = menuOpen ? dropdown : null
  let height = PAD * 2 + pillEl.offsetHeight
  const content = { x: HPAD, y: PAD, w: pillEl.offsetWidth, h: pillEl.offsetHeight }
  if (dd && !dd.classList.contains('hidden')) {
    height += 10 + dd.offsetHeight
    content.h += 10 + dd.offsetHeight
  }
  // 展开菜单会改变窗口高度；column-reverse 的中间布局会受当前视口影响，
  // 因此不要读取中间态 rect，直接按目标高度计算药丸位置。
  const pillY = document.body.classList.contains('up')
    ? height - PAD - pillEl.offsetHeight
    : PAD
  window.tbAPI.fit({
    height: Math.round(height),
    width: Math.round(pillEl.offsetWidth) + HPAD * 2,
    pillY: Math.round(pillY),
    content
  })
}

function setMenu(open) {
  menuOpen = open
  dropdown.classList.toggle('hidden', !open)
  requestAnimationFrame(reportFit)
}

pillEl.addEventListener('click', e => {
  const btn = e.target.closest('button')
  if (!btn || btn.classList.contains('more-btn')) return
  const act = btn.dataset.act
  if (act === 'ask' || act === 'summary' || act === 'translate') {
    window.tbAPI.ask(act)
  } else if (act === 'copy') {
    window.tbAPI.copy()
  }
})

document.querySelector('.more-btn').addEventListener('click', () => setMenu(!menuOpen))

dropdown.addEventListener('click', e => {
  const btn = e.target.closest('.row')
  if (!btn) return
  const act = btn.dataset.act
  if (act === 'explain') window.tbAPI.ask('explain')
  else if (act === 'disable') window.tbAPI.disableApp()
  else if (act === 'settings') window.tbAPI.openSettings()
})

window.tbAPI.onPayload(p => {
  // 每次展示重置状态
  dropdown.classList.add('hidden')
  menuOpen = false
  document.body.classList.toggle('up', p.menuDir === 'up')
  disableLabel.textContent = p.appName ? `在${p.appName}中禁用` : '在此应用中禁用'
  pillEl.classList.toggle('pending', !!p.pending)
  requestAnimationFrame(reportFit)
})

reportFit()
