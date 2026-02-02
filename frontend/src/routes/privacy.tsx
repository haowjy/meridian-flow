import { createFileRoute, useRouter, useCanGoBack } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'

export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
})

function PrivacyPage() {
  const router = useRouter()
  const canGoBack = useCanGoBack()

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto max-w-2xl px-6 py-8">
        {/* Back button - respects navigation history */}
        <button
          onClick={() => {
            if (canGoBack) {
              router.history.back()
            } else {
              router.navigate({ to: '/' })
            }
          }}
          className="mb-8 inline-flex items-center gap-2 type-label text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="size-4" />
          Back
        </button>

        {/* Page title */}
        <h1 className="mb-8 type-display">Privacy Policy</h1>

        <div className="space-y-6 type-body text-foreground">
          <p className="text-muted-foreground">
            Last updated: January 2025
          </p>

          {/* Introduction */}
          <section className="space-y-3">
            <h2 className="type-section">Introduction</h2>
            <p>
              This privacy policy describes how Meridian ("we", "us") collects, uses, and shares personal information of users of meridian-flow.com and associated services (the "Services"). By using the Services, you consent to the practices described in this policy.
            </p>
          </section>

          {/* Information We Collect */}
          <section className="space-y-3">
            <h2 className="type-section">Information We Collect</h2>

            <p><strong>User Content:</strong> Content you create and upload to Meridian, including documents, projects, prompts to AI features, and other files.</p>

            <p><strong>Account Information:</strong> Information you provide when creating an account, such as your name, email address, and authentication provider identifiers.</p>

            <p><strong>Automatically Collected Information:</strong> When you use our Services, we may automatically collect information such as your device type, operating system, browser type, IP address, and general usage patterns.</p>

            <p><strong>Cookies:</strong> We use cookies and similar technologies to provide functionality and personalize your experience. This includes session cookies (which expire when you close your browser) and persistent cookies (which remain until deleted).</p>
          </section>

          {/* How We Use Your Information */}
          <section className="space-y-3">
            <h2 className="type-section">How We Use Your Information</h2>
            <p>We use your information to:</p>
            <ul className="list-disc pl-6 space-y-2">
              <li>Provide, maintain, and personalize the Services</li>
              <li>Process and fulfill your requests</li>
              <li>Send service-related communications</li>
              <li>Conduct research and development using aggregated, anonymized data</li>
              <li>Comply with legal obligations and protect our rights</li>
            </ul>
            <p className="font-medium">
              We do not use your personal information to train AI models.
            </p>
          </section>

          {/* How We Share Your Information */}
          <section className="space-y-3">
            <h2 className="type-section">How We Share Your Information</h2>

            <p><strong>Service Providers:</strong> We share information with third-party service providers who help us operate the Services, including cloud hosting, database, authentication, and AI providers. These may include services such as Supabase, Anthropic, and similar providers. When you use AI features, relevant content is sent to AI providers to process your requests.</p>

            <p><strong>Professional Advisors:</strong> We may share information with lawyers, accountants, and other advisors in the course of their services to us.</p>

            <p><strong>Corporate Transactions:</strong> If Meridian is involved in a merger, acquisition, or sale of assets, your information may be transferred as part of that transaction.</p>

            <p><strong>Legal Requirements:</strong> We may disclose information to comply with applicable laws, respond to legal process, or protect our rights and the safety of others.</p>

            <p className="font-medium">
              We do not sell your personal information.
            </p>
          </section>

          {/* Your Choices */}
          <section className="space-y-3">
            <h2 className="type-section">Your Choices</h2>
            <ul className="list-disc pl-6 space-y-2">
              <li><strong>Email Communications:</strong> You may opt out of promotional emails by following the unsubscribe instructions in those messages.</li>
              <li><strong>Cookies:</strong> You can configure your browser to reject cookies, though this may affect functionality.</li>
              <li><strong>Account Deletion:</strong> You may request deletion of your account and associated data by contacting us.</li>
            </ul>
          </section>

          {/* Security */}
          <section className="space-y-3">
            <h2 className="type-section">Security</h2>
            <p>
              We implement appropriate security measures to protect your information, including encrypted connections and secure authentication. However, no method of transmission over the Internet is 100% secure, and we cannot guarantee absolute security.
            </p>
          </section>

          {/* Children */}
          <section className="space-y-3">
            <h2 className="type-section">Children</h2>
            <p>
              The Services are not intended for children under 13 years of age. We do not knowingly collect personal information from children under 13. If you believe we have collected information from a child under 13, please contact us.
            </p>
          </section>

          {/* Changes to This Policy */}
          <section className="space-y-3">
            <h2 className="type-section">Changes to This Policy</h2>
            <p>
              We may update this privacy policy from time to time. We will post the revised policy on this page and update the "Last updated" date. Continued use of the Services after changes constitutes acceptance of the updated policy.
            </p>
          </section>

          {/* Contact */}
          <section className="space-y-3">
            <h2 className="type-section">Contact</h2>
            <p>
              For privacy-related questions or requests, contact us at{' '}
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
