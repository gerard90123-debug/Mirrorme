import { useEffect, useMemo, useRef, useState } from 'react'
import Orb from './components/Orb.jsx'
import ChatView from './components/ChatView.jsx'
import VoicePanel from './components/VoicePanel.jsx'
import SettingsPanel from './components/SettingsPanel.jsx'
import { chat, getConfig, setApiSettings, tts } from './lib/api.js'
import { AudioEngine } from './lib/audio.js'
import { load, save, uid } from './lib/storage.js'

const DEFAULT_SLOTS = [
  {
    id: 'self', name: '另一个我', relation: 'self',
    traits: '敏感、诚实、温和但有一点倔强', tone: '像深夜自言自语，简短、有停顿感',
    voiceId: null, voiceStatus: null, custom: false,
  },
  {
    id: 'friend', name: '朋友声线', relation: 'friend',
    traits: '熟悉、放松、说话随口不客套', tone: '像老朋友发语音，自然、有自己的节奏',
    voiceId: null, voiceStatus: null, custom: false,
  },
]

const DEFAULT_SETTINGS = { deepseekKey: '', dashscopeKey: '', baseUrl: '' }

const TuneIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" />
  </svg>
)
const GearIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.1A1.7 1.7 0 0 0 8.97 19.3a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.1A1.7 1.7 0 0 0 4.7 8.97a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9.07 4.6 1.7 1.7 0 0 0 10.1 3.04V3h4v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21v4h-.1A1.7 1.7 0 0 0 19.4 15z" />
  </svg>
)

export default function App() {
  const [slots, setSlots] = useState(() => {
    const stored = load('slots', null)
    return Array.isArray(stored) && stored.length ? stored : DEFAULT_SLOTS
  })
  const [activeSlotId, setActiveSlotId] = useState(() => load('activeSlotId', 'self'))
  const [messages, setMessages] = useState(() => load('messages', []))
  const [corrections, setCorrections] = useState(() => load('corrections', []))
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...(load('settings', {}) || {}) }))
  const [config, setConfig] = useState(null)
  const [lastError, setLastError] = useState('')
  const [notice, setNotice] = useState('')
  const [panel, setPanel] = useState(null)
  const [speaking, setSpeaking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState('')

  const engineRef = useRef(null)
  if (!engineRef.current) engineRef.current = new AudioEngine()

  const activeSlot = useMemo(
    () => slots.find((s) => s.id === activeSlotId) || slots[0],
    [slots, activeSlotId]
  )
  const correctionLabel = activeSlot?.relation === 'friend' ? '不像TA' : '不像我'

  useEffect(() => { save('slots', slots) }, [slots])
  useEffect(() => { save('activeSlotId', activeSlotId) }, [activeSlotId])
  useEffect(() => { save('messages', messages) }, [messages])
  useEffect(() => { save('corrections', corrections) }, [corrections])
  useEffect(() => { save('settings', settings) }, [settings])

  useEffect(() => { setApiSettings(() => settings) }, [settings])

  useEffect(() => {
    let alive = true
    getConfig().then((c) => { if (alive) setConfig(c) }).catch((e) => {
      if (alive) setLastError(e.message)
    })
    return () => { alive = false }
  }, [settings])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(''), 6500)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => () => engineRef.current.stop(), [])

  const speak = async (slot, text) => {
    const engine = engineRef.current
    const done = () => setSpeaking(false)
    if (slot?.voiceId) {
      try {
        const res = await tts({ text, voiceId: slot.voiceId })
        if (res.audioBase64) {
          setSpeaking(true)
          await engine.playBase64(res.audioBase64, res.mimeType, done)
          return
        }
        if (res.audioUrl) {
          setSpeaking(true)
          await engine.playUrl(res.audioUrl, done)
          return
        }
      } catch (e) {
        setLastError(e.message)
        setNotice(`音色合成暂不可用（${e.code || '错误'}），已自动改用浏览器朗读，波纹照常工作。`)
      }
    }
    if (engine.playBrowser(text, done)) {
      setSpeaking(true)
    } else {
      setNotice('当前浏览器不支持语音朗读，波纹仍会轻轻回应你。')
    }
  }

  const handleSend = async (text) => {
    if (busy || !text?.trim()) return
    // 用户手势内解锁 AudioContext（iOS 必需）
    engineRef.current.ensureContext()
    engineRef.current.stop()
    setSpeaking(false)
    setNotice('')
    setLastError('')

    const userMessage = { id: uid(), role: 'user', text: text.trim(), time: Date.now() }
    const nextMessages = [...messages, userMessage]
    setMessages(nextMessages)
    setBusy(true)

    try {
      const res = await chat({
        messages: nextMessages.slice(-16).map((m) => ({ role: m.role, content: m.text })),
        persona: { relation: activeSlot?.relation, traits: activeSlot?.traits, tone: activeSlot?.tone },
        corrections: corrections.filter((c) => c.slotId === activeSlot?.id),
        slotName: activeSlot?.name,
      })
      const reply = { id: uid(), role: 'assistant', text: res.reply, time: Date.now() }
      setMessages((prev) => [...prev, reply])
      setBusy(false)
      await speak(activeSlot, res.reply)
    } catch (e) {
      setBusy(false)
      setLastError(e.message)
      setNotice(e.message)
      setMessages((prev) => [...prev, {
        id: uid(), role: 'assistant', time: Date.now(),
        text: '（我这边刚才走神了一下……不过我还在，你再说一遍给我听好吗？）',
        degraded: true,
      }])
    }
  }

  const handleSaveCorrection = (messageId, text) => {
    const rule = { id: uid(), slotId: activeSlot?.id, messageId, text, createdAt: Date.now() }
    setCorrections((prev) => [...prev, rule])
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, correctionText: text } : m)))
    setNotice('记住了。之后我会按你说的样子说话。')
  }

  const handleUpdateSlot = (slotId, patch) => {
    setSlots((prev) => prev.map((s) => (s.id === slotId ? { ...s, ...patch } : s)))
  }

  const handleAddSlot = (name) => {
    const slot = {
      id: `custom-${uid()}`, name, relation: 'friend', custom: true,
      traits: '按用户的纠偏规则逐渐形成', tone: '自然、跟随用户习惯',
      voiceId: null, voiceStatus: null,
    }
    setSlots((prev) => [...prev, slot])
    setActiveSlotId(slot.id)
  }

  const handleDeleteSlot = (slotId) => {
    setSlots((prev) => {
      const next = prev.filter((s) => s.id !== slotId)
      return next.length ? next : prev
    })
    if (activeSlotId === slotId) setActiveSlotId(slots.find((s) => s.id !== slotId)?.id || 'self')
    setCorrections((prev) => prev.filter((c) => c.slotId !== slotId))
  }

  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult('正在检查…')
    try {
      const c = await getConfig()
      setConfig(c)
      setLastError('')
      const bits = [
        `DeepSeek ${c.deepseek?.configured ? '已填入' : '未配置'}`,
        `百炼 ${c.dashscope?.configured ? '已填入' : '未配置'}`,
      ]
      let detail = ''
      if (c.deepseek?.configured) {
        try {
          await chat({
            messages: [{ role: 'user', content: '只回复两个字：收到' }],
            persona: {}, corrections: [], slotName: 'MirrorMe',
          })
          detail = ' · 对话实测成功'
        } catch (e2) {
          detail = ` · 对话实测失败：${e2.message}`
        }
      }
      const summary = `检查完成：${bits.join(' · ')}${detail}。`
      setTestResult(summary)
      setNotice(summary)
    } catch (e) {
      setLastError(e.message)
      setTestResult(`检查失败：${e.message}`)
      setNotice(e.message)
    } finally {
      setTesting(false)
    }
  }

  const handleGetLevel = () => engineRef.current.getLevel()

  return (
    <div className="app-shell">
      <div className="phone">
        <header className="topbar">
          <div className="topbar-left">
            <span className="status-dot" />
            <div style={{ minWidth: 0 }}>
              <div className="topbar-name">{activeSlot?.name || 'MirrorMe'}</div>
              <div className="topbar-sub">
                {activeSlot?.voiceId ? '专属音色' : '浏览器音色'} · 已记住 {corrections.filter((c) => c.slotId === activeSlot?.id).length} 条纠偏
              </div>
            </div>
          </div>
          <div className="topbar-actions">
            <button className="icon-btn" onClick={() => setPanel('voice')} aria-label="调音色"><TuneIcon /></button>
            <button className="icon-btn" onClick={() => setPanel('settings')} aria-label="设置"><GearIcon /></button>
          </div>
        </header>

        <Orb getLevel={handleGetLevel} speaking={speaking} listening={false} />

        <ChatView
          messages={messages}
          slot={activeSlot}
          correctionLabel={correctionLabel}
          onSend={handleSend}
          onSpeak={(text) => speak(activeSlot, text)}
          onSaveCorrection={handleSaveCorrection}
          onNotice={setNotice}
          busy={busy}
        />

        {notice && <div className="notice">{notice}</div>}

        {panel === 'voice' && (
          <VoicePanel
            slots={slots}
            activeSlotId={activeSlotId}
            onSelect={(id) => { setActiveSlotId(id); setPanel(null) }}
            onUpdateSlot={handleUpdateSlot}
            onAddSlot={handleAddSlot}
            onDeleteSlot={handleDeleteSlot}
            onTest={(slot) => speak(slot, '今天的风很轻，我在这里等你。')}
            onNotice={setNotice}
            onClose={() => setPanel(null)}
          />
        )}
        {panel === 'settings' && (
          <SettingsPanel
            settings={settings}
            onChange={setSettings}
            config={config}
            onClose={() => setPanel(null)}
            onTest={handleTestConnection}
            testing={testing}
            lastError={lastError}
            singleFile={config?.singleFile === true}
            testResult={testResult}
          />
        )}
      </div>
    </div>
  )
}
