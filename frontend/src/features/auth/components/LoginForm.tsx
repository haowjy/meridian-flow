import { createClient } from '@/core/supabase/client'
import { Button } from '@/shared/components/ui/button'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { InlineError } from '@/shared/components/InlineError'
import { CheckCircle } from 'lucide-react'
import { FormEvent, useState } from 'react'

export function LoginForm() {
    const supabase = createClient()
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [isLoading, setIsLoading] = useState(false)
    const [isSignUp, setIsSignUp] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [successMessage, setSuccessMessage] = useState<string | null>(null)

    const handleEmailLogin = async (e: FormEvent) => {
        e.preventDefault()
        setError(null)
        setIsLoading(true)
        try {
            const { error: authError } = await supabase.auth.signInWithPassword({
                email,
                password,
            })
            if (authError) {
                setError(authError.message)
            } else {
                // Supabase sets session cookies automatically
                window.location.href = '/projects'
            }
        } catch (err) {
            console.error('Email login failed', err)
            setError('An unexpected error occurred')
        } finally {
            setIsLoading(false)
        }
    }

    const handleEmailSignUp = async (e: FormEvent) => {
        e.preventDefault()
        setError(null)
        setSuccessMessage(null)
        setIsLoading(true)
        try {
            const { error: authError } = await supabase.auth.signUp({
                email,
                password,
            })
            if (authError) {
                setError(authError.message)
            } else {
                setSuccessMessage('Check your email for a confirmation link!')
                setEmail('')
                setPassword('')
                setIsSignUp(false)
            }
        } catch (err) {
            console.error('Email sign up failed', err)
            setError('An unexpected error occurred')
        } finally {
            setIsLoading(false)
        }
    }

    const handleGoogleLogin = async () => {
        setError(null)
        setSuccessMessage(null)
        try {
            const { error: authError } = await supabase.auth.signInWithOAuth({
                provider: 'google',
                options: {
                    redirectTo: `${window.location.origin}/auth/callback`,
                },
            })

            if (authError) {
                setError(authError.message)
            }
        } catch (err) {
            console.error('Google login failed', err)
            setError('An unexpected error occurred')
        }
    }

    // Clear messages when switching between sign in/sign up
    const handleToggleMode = (signUp: boolean) => {
        setError(null)
        setSuccessMessage(null)
        setIsSignUp(signUp)
    }

    return (
        <div className="w-full max-w-sm mx-auto">
            {/* Container with elegant styling */}
            <div className="bg-card rounded-xl border border-border/50 p-5 shadow-[var(--shadow-2)]">
                {/* Header */}
                <div className="text-center mb-5">
                    <h1 className="font-serif text-xl font-semibold text-foreground">
                        {isSignUp ? 'Create account' : 'Welcome back'}
                    </h1>
                    <p className="mt-2 text-sm text-muted-foreground">
                        {isSignUp
                            ? 'Start your writing journey'
                            : 'Sign in to continue writing'
                        }
                    </p>
                </div>

                {/* Success message */}
                {successMessage && (
                    <div className="mb-4 flex items-center gap-2 rounded-lg border border-success/50 bg-success/10 px-3 py-2" role="status">
                        <CheckCircle className="h-4 w-4 shrink-0 text-success" />
                        <span className="text-sm text-success">{successMessage}</span>
                    </div>
                )}

                {/* Error message */}
                {error && (
                    <div className="mb-4">
                        <InlineError message={error} onDismiss={() => setError(null)} />
                    </div>
                )}

                {/* Google button */}
                <Button
                    variant="outline"
                    size="lg"
                    className="w-full"
                    onClick={handleGoogleLogin}
                >
                    <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
                        <path
                            fill="#4285F4"
                            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                            fill="#34A853"
                            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                            fill="#FBBC05"
                            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                            fill="#EA4335"
                            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                    </svg>
                    Continue with Google
                </Button>

                {/* Divider */}
                <div className="relative my-3">
                    <div className="absolute inset-0 flex items-center">
                        <div className="w-full border-t border-border/50" />
                    </div>
                    <div className="relative flex justify-center">
                        <span className="bg-card px-3 text-xs text-muted-foreground">
                            or continue with email
                        </span>
                    </div>
                </div>

                {/* Email form */}
                <form onSubmit={isSignUp ? handleEmailSignUp : handleEmailLogin} className="space-y-3">
                    <div className="space-y-2">
                        <Label htmlFor="email" className="text-sm font-medium">
                            Email
                        </Label>
                        <Input
                            id="email"
                            type="email"
                            placeholder="you@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            size="lg"
                            required
                        />
                    </div>
                    <div className="space-y-2">
                        <Label htmlFor="password" className="text-sm font-medium">
                            Password
                        </Label>
                        <Input
                            id="password"
                            type="password"
                            placeholder="••••••••"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            size="lg"
                            required
                        />
                    </div>
                    <Button
                        type="submit"
                        size="lg"
                        className="w-full mt-2"
                        disabled={isLoading}
                    >
                        {isLoading
                            ? (isSignUp ? 'Creating account...' : 'Signing in...')
                            : (isSignUp ? 'Create account' : 'Sign in')
                        }
                    </Button>
                </form>

                {/* Toggle sign in / sign up */}
                <p className="mt-5 text-center text-sm text-muted-foreground">
                    {isSignUp ? (
                        <>
                            Already have an account?{' '}
                            <button
                                type="button"
                                className="font-medium text-foreground hover:text-primary transition-colors"
                                onClick={() => handleToggleMode(false)}
                            >
                                Sign in
                            </button>
                        </>
                    ) : (
                        <>
                            Don&apos;t have an account?{' '}
                            <button
                                type="button"
                                className="font-medium text-foreground hover:text-primary transition-colors"
                                onClick={() => handleToggleMode(true)}
                            >
                                Sign up
                            </button>
                        </>
                    )}
                </p>
            </div>
        </div>
    )
}
