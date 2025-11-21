import { LoginForm } from '@/features/auth/components/LoginForm'
import { LogoWordmark } from '@/shared/components/LogoWordmark'

export default function LoginPage() {
    return (
        <div className="min-h-screen flex flex-col items-center justify-center p-4 bg-muted/50">
            <div className="mb-8">
                <LogoWordmark className="h-8" />
            </div>
            <LoginForm />
        </div>
    )
}
