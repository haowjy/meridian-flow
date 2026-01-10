import { useErrorStore } from '@/core/stores/useErrorStore'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog'
import { Button } from '@/shared/components/ui/button'
import { LogIn } from 'lucide-react'

/**
 * Modal shown when user session has expired (401 from API).
 *
 * This modal requires user action - the user must sign in again
 * to continue using the app. No dismiss/close button is shown.
 */
export function SessionExpiredModal() {
  const sessionExpired = useErrorStore((s) => s.sessionExpired)
  const clearSessionExpired = useErrorStore((s) => s.clearSessionExpired)

  const handleSignIn = () => {
    clearSessionExpired()
    // Redirect to login page
    window.location.href = '/login'
  }

  return (
    <Dialog open={sessionExpired}>
      <DialogContent showCloseButton={false} onPointerDownOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Session Expired</DialogTitle>
          <DialogDescription>
            Your session has expired. Please sign in again to continue.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={handleSignIn} className="w-full sm:w-auto">
            <LogIn className="mr-2 h-4 w-4" />
            Sign in
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
