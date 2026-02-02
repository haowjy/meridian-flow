import { createFileRoute, Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
})

function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-2xl px-6 py-8">
        {/* Back button */}
        <Link
          to="/"
          className="mb-8 inline-flex items-center gap-2 type-label text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back
        </Link>

        {/* Page title */}
        <h1 className="mb-8 type-display">Terms of Service</h1>

        <div className="space-y-6 type-body text-foreground">
          <p className="text-muted-foreground">
            Last updated: January 2025
          </p>

          <section className="space-y-3">
            <h2 className="type-section">Acceptance of Terms</h2>
            <p>
              By accessing or using Meridian, you agree to be bound by these Terms of Service. If you do not agree to these terms, please do not use the service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">Account Responsibilities</h2>
            <p>
              You are responsible for maintaining the security of your account and any activity that occurs under your account. You must provide accurate information when creating your account and keep it up to date.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">Your Content</h2>
            <p>
              You retain full ownership of all content you create in Meridian, including documents, projects, and any other materials. We do not claim any ownership rights over your work.
            </p>
            <p>
              You grant Meridian a limited license to store, display, and process your content solely for the purpose of providing the service to you.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">AI Features</h2>
            <p>
              Meridian includes AI-powered writing assistance features. Please note:
            </p>
            <ul className="list-disc pl-6 space-y-2">
              <li>AI-generated suggestions are provided as-is and may not always be accurate or appropriate</li>
              <li>You are responsible for reviewing and editing any AI-generated content before use</li>
              <li>Content you submit to AI features may be processed by third-party AI providers</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">Acceptable Use</h2>
            <p>You agree not to:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Use the service for any unlawful purpose</li>
              <li>Attempt to gain unauthorized access to the service or its systems</li>
              <li>Interfere with or disrupt the service or servers</li>
              <li>Use the service to harass, abuse, or harm others</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">Limitation of Liability</h2>
            <p>
              Meridian is provided "as is" without warranties of any kind. We are not liable for any damages arising from your use of the service, including but not limited to data loss, service interruptions, or errors in AI-generated content.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">Termination</h2>
            <p>
              We reserve the right to suspend or terminate your access to Meridian at any time for violations of these terms. You may also delete your account at any time.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">Changes to Terms</h2>
            <p>
              We may update these terms from time to time. Continued use of the service after changes constitutes acceptance of the new terms.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="type-section">Contact</h2>
            <p>
              For questions about these terms, contact us at{' '}
              <a
                href="mailto:dev.jimm.py@gmail.com"
                className="text-primary hover:underline"
              >
                dev.jimm.py@gmail.com
              </a>
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}
