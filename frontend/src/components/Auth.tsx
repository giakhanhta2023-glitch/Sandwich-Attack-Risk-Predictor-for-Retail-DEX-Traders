import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  MIN_PASSWORD,
  USERNAME_RULE,
  authConfigured,
  register,
  sendPasswordReset,
  signIn,
  signOut,
  updatePassword,
  useAccount,
  useRecovery,
  usernameAvailable,
} from '@/lib/auth'
import type { Account } from '@/lib/auth'
import { Link } from '@/lib/router'
import { cn } from '@/lib/utils'

type Mode = 'signin' | 'register'

/**
 * Sign in and create an account.
 *
 * The form only collects and checks shape; Supabase Auth does the rest, so no
 * password is stored, compared or logged anywhere in this codebase.
 */
export function AuthDialog({
  open,
  onOpenChange,
  initialMode = 'signin',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialMode?: Mode
}) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [nameTaken, setNameTaken] = useState(false)

  useEffect(() => {
    if (open) {
      setMode(initialMode)
      setError(null)
      setNotice(null)
    }
  }, [open, initialMode])

  // Say the name is gone while they are still typing, rather than after the
  // sign-up fails on it.
  useEffect(() => {
    if (mode !== 'register' || !USERNAME_RULE.test(username)) {
      setNameTaken(false)
      return
    }
    let alive = true
    const t = setTimeout(() => {
      usernameAvailable(username).then((free) => alive && setNameTaken(!free))
    }, 400)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [username, mode])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password)
        onOpenChange(false)
      } else {
        const { confirmEmail } = await register(username.trim(), email.trim(), password)
        if (confirmEmail) {
          setNotice(`Account created. Confirm it from the email sent to ${email.trim()}, then sign in.`)
          setMode('signin')
          setPassword('')
        } else {
          onOpenChange(false)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async () => {
    if (!email.trim()) {
      setError('Enter your email first, then ask for a reset link.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await sendPasswordReset(email.trim())
      setNotice(`Reset link sent to ${email.trim()}.`)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const canSubmit =
    email.includes('@') &&
    password.length >= MIN_PASSWORD &&
    (mode === 'signin' || (USERNAME_RULE.test(username) && !nameTaken))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === 'signin' ? 'Sign in' : 'Create an account'}</DialogTitle>
          <DialogDescription>
            {mode === 'signin'
              ? 'Your saved trades, on any device.'
              : 'Keep the trades you analyse. No wallet, no funds, nothing to connect.'}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-3">
          {mode === 'register' && (
            <div className="grid gap-1.5">
              <Label htmlFor="auth-username" className="eyebrow">
                Username
              </Label>
              <Input
                id="auth-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="satoshi_1"
                autoComplete="username"
                aria-invalid={nameTaken || undefined}
                className="num"
                required
              />
              <p className={cn('text-[0.625rem]', nameTaken ? 'text-hot' : 'text-ink-faint')}>
                {nameTaken ? 'That username is taken.' : '3 to 24 letters, numbers or underscores.'}
              </p>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="auth-email" className="eyebrow">
              Email
            </Label>
            <Input
              id="auth-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="num"
              required
            />
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="auth-password" className="eyebrow">
              Password
            </Label>
            <Input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={MIN_PASSWORD}
              className="num"
              required
            />
            {mode === 'register' && (
              <p className="text-[0.625rem] text-ink-faint">At least {MIN_PASSWORD} characters.</p>
            )}
          </div>

          {error && <p className="text-[0.6875rem] leading-relaxed text-hot">{error}</p>}
          {notice && <p className="text-[0.6875rem] leading-relaxed text-cool">{notice}</p>}

          <Button
            type="submit"
            disabled={!canSubmit || busy}
            className="h-9 w-full rounded-sm text-[0.8125rem] font-medium"
          >
            {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <div className="mt-4 flex items-center justify-between text-[0.6875rem]">
          <button
            type="button"
            onClick={() => {
              setMode(mode === 'signin' ? 'register' : 'signin')
              setError(null)
              setNotice(null)
            }}
            className="text-ink-dim underline decoration-line-bright underline-offset-2 hover:text-ink"
          >
            {mode === 'signin' ? 'Create an account' : 'I already have an account'}
          </button>
          {mode === 'signin' && (
            <button
              type="button"
              onClick={resetPassword}
              disabled={busy}
              className="text-ink-dim underline decoration-line-bright underline-offset-2 hover:text-ink"
            >
              Forgot password?
            </button>
          )}
        </div>

        <p className="mt-3 text-[0.625rem] leading-relaxed text-ink-faint">
          We keep your email, your username, and the trades you choose to save. Nothing else.{' '}
          <Link to="/privacy" className="underline decoration-line-bright underline-offset-2 hover:text-ink">
            Privacy
          </Link>
        </p>
      </DialogContent>
    </Dialog>
  )
}

/** Opens itself when someone arrives from a password-reset link. */
export function PasswordRecovery() {
  const [open, setOpen] = useRecovery()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!authConfigured) return null

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await updatePassword(password)
      setOpen(false)
      // drop the reset token from the address bar
      window.history.replaceState(null, '', window.location.pathname)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set a new password</DialogTitle>
          <DialogDescription>You are signed in from the reset link. Choose a new password.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="grid gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="new-password" className="eyebrow">
              New password
            </Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              minLength={MIN_PASSWORD}
              className="num"
              required
            />
            <p className="text-[0.625rem] text-ink-faint">At least {MIN_PASSWORD} characters.</p>
          </div>
          {error && <p className="text-[0.6875rem] leading-relaxed text-hot">{error}</p>}
          <Button
            type="submit"
            disabled={password.length < MIN_PASSWORD || busy}
            className="h-9 w-full rounded-sm text-[0.8125rem] font-medium"
          >
            {busy ? 'Working\u2026' : 'Save password'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Header control: sign in, or who you are signed in as. */
export function AccountButton() {
  const { account, loading } = useAccount()
  const [open, setOpen] = useState(false)
  if (!authConfigured || loading) return null

  return (
    <>
      {account ? (
        <AccountBar account={account} />
      ) : (
        <Button
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          className="h-6 rounded-sm border-line bg-transparent px-2 font-mono text-[0.625rem] text-ink-dim hover:bg-raised hover:text-ink"
        >
          Sign in
        </Button>
      )}
      <AuthDialog open={open} onOpenChange={setOpen} />
    </>
  )
}

function AccountBar({ account }: { account: Account }) {
  return (
    <span className="flex items-center gap-1.5 rounded-sm border border-line px-2 py-0.5 font-mono text-[0.625rem]">
      <Link to="/saved" className="text-ink hover:underline" title="Your saved trades">
        {account.username}
      </Link>
      <button
        type="button"
        onClick={() => signOut()}
        className="text-ink-faint transition-colors hover:text-hot"
        title="Sign out"
      >
        out
      </button>
    </span>
  )
}
