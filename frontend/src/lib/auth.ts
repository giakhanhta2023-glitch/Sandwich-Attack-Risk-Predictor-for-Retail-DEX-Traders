import { createClient } from '@supabase/supabase-js'
import type { Session } from '@supabase/supabase-js'
import { useEffect, useState } from 'react'

/**
 * Accounts, with Supabase Auth doing the parts that must not be improvised.
 *
 * A password is sent straight to Supabase over TLS and hashed there. It never
 * reaches this code, the Python API, or any table this project owns. What
 * comes back is a session, kept in the browser so a refresh does not sign you
 * out, and sent with every read and write below, so row level security in
 * the database, not the UI, decides what a signed-in trader can touch: their
 * own rows, nothing else.
 */

const URL = import.meta.env.VITE_SUPABASE_URL as string | undefined
const KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined

export const authConfigured = Boolean(URL && KEY)

export const supabase = authConfigured
  ? createClient(URL as string, KEY as string, {
      // A reset link comes back with its token in the URL, so the client has to
      // read it; the recovery dialog then takes over.
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  : null

export const USERNAME_RULE = /^[A-Za-z0-9_]{3,24}$/
export const MIN_PASSWORD = 8

export interface Account {
  id: string
  email: string | null
  username: string
}

/** Supabase's messages are written for developers; these are for traders. */
function friendly(message: string): string {
  const m = message.toLowerCase()
  if (m.includes('invalid login credentials')) return 'Wrong email or password.'
  if (m.includes('email not confirmed')) return 'Confirm your email first, then sign in.'
  if (m.includes('already registered')) return 'That email already has an account. Sign in instead.'
  if (m.includes('rate limit') || m.includes('too many')) return 'Too many attempts. Wait a minute and try again.'
  if (m.includes('password')) return `Use at least ${MIN_PASSWORD} characters for the password.`
  return message
}

/** The signed-in account, or null. Follows sign-in and sign-out as they happen. */
export function useAccount(): { account: Account | null; loading: boolean } {
  const [session, setSession] = useState<Session | null>(null)
  const [username, setUsername] = useState<string | null>(null)
  const [loading, setLoading] = useState(authConfigured)

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next))
    return () => data.subscription.unsubscribe()
  }, [])

  const userId = session?.user.id
  useEffect(() => {
    if (!supabase || !userId) {
      setUsername(null)
      return
    }
    let alive = true
    supabase
      .from('profiles')
      .select('username')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (alive) setUsername((data as { username?: string } | null)?.username ?? null)
      })
    return () => {
      alive = false
    }
  }, [userId])

  const account = session
    ? {
        id: session.user.id,
        email: session.user.email ?? null,
        username: username ?? session.user.email?.split('@')[0] ?? 'trader',
      }
    : null
  return { account, loading }
}

export async function usernameAvailable(name: string): Promise<boolean> {
  if (!supabase || !USERNAME_RULE.test(name)) return false
  const { data, error } = await supabase.rpc('username_available', { name })
  return !error && data === true
}

/** Creates the account. The profile row is written by the database, from the
 *  username sent here, so a browser can never claim one for someone else. */
export async function register(username: string, email: string, password: string): Promise<{ confirmEmail: boolean }> {
  if (!supabase) throw new Error('Accounts are not configured for this deployment.')
  if (!USERNAME_RULE.test(username)) throw new Error('Username: 3 to 24 letters, numbers or underscores.')
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for the password.`)
  if (!(await usernameAvailable(username))) throw new Error('That username is taken.')

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  })
  if (error) throw new Error(friendly(error.message))
  // With email confirmation on, Supabase returns a user but no session yet.
  return { confirmEmail: !data.session }
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error('Accounts are not configured for this deployment.')
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(friendly(error.message))
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut()
}

export async function sendPasswordReset(email: string): Promise<void> {
  if (!supabase) throw new Error('Accounts are not configured for this deployment.')
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/`,
  })
  if (error) throw new Error(friendly(error.message))
}

export async function updatePassword(password: string): Promise<void> {
  if (!supabase) throw new Error('Accounts are not configured for this deployment.')
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for the password.`)
  const { error } = await supabase.auth.updateUser({ password })
  if (error) throw new Error(friendly(error.message))
}

/** True once a password-reset link has been opened, until the new password is set. */
export function useRecovery(): [boolean, (open: boolean) => void] {
  const [recovering, setRecovering] = useState(false)
  useEffect(() => {
    if (!supabase) return
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') setRecovering(true)
    })
    return () => data.subscription.unsubscribe()
  }, [])
  return [recovering, setRecovering]
}

export interface SavedTrade {
  id: string
  pool_id: string
  pool_symbol: string
  notional_usd: number
  slippage_bps: number
  p_attack: number | null
  risk_band: string | null
  recommended_slippage_bps: number | null
  expected_saving_usd: number | null
  note: string | null
  created_at: string
}

export type NewSavedTrade = Omit<SavedTrade, 'id' | 'created_at'>

/** user_id is filled in by the database from the session, so a saved trade
 *  cannot be written into someone else's list. */
export async function saveTrade(trade: NewSavedTrade): Promise<void> {
  if (!supabase) throw new Error('Accounts are not configured for this deployment.')
  const { error } = await supabase.from('saved_trades').insert(trade)
  if (error) throw new Error(error.message)
}

export async function listSavedTrades(): Promise<SavedTrade[]> {
  if (!supabase) return []
  const { data, error } = await supabase
    .from('saved_trades')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  return (data ?? []) as SavedTrade[]
}

export async function deleteSavedTrade(id: string): Promise<void> {
  if (!supabase) return
  const { error } = await supabase.from('saved_trades').delete().eq('id', id)
  if (error) throw new Error(error.message)
}
