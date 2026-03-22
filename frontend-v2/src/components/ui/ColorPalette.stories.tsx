import type { Meta, StoryObj } from "@storybook/react-vite"

/* ------------------------------------------------------------------ */
/* Swatch component                                                   */
/* ------------------------------------------------------------------ */

type SwatchProps = {
  name: string
  token: string
  bg: string
  fg?: string
  border?: boolean
}

function Swatch({ name, token, bg, fg, border }: SwatchProps) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="size-10 shrink-0 rounded-md"
        style={{
          backgroundColor: bg,
          color: fg,
          border: border ? "1px solid var(--border)" : undefined,
        }}
      />
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">{token}</p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Pair swatch (bg + foreground together)                              */
/* ------------------------------------------------------------------ */

type PairSwatchProps = {
  name: string
  bgToken: string
  fgToken: string
  bg: string
  fg: string
  border?: boolean
}

function PairSwatch({ name, bgToken, fgToken, bg, fg, border }: PairSwatchProps) {
  return (
    <div className="flex items-center gap-3">
      <div
        className="flex size-10 shrink-0 items-center justify-center rounded-md text-xs font-bold"
        style={{
          backgroundColor: bg,
          color: fg,
          border: border ? "1px solid var(--border)" : undefined,
        }}
      >
        Aa
      </div>
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-foreground">{name}</p>
        <p className="truncate font-mono text-xs text-muted-foreground">
          {bgToken} / {fgToken}
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Section layout                                                      */
/* ------------------------------------------------------------------ */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="border-b border-border pb-1 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-3">{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Palette page                                                        */
/* ------------------------------------------------------------------ */

function ColorPalettePage() {
  return (
    <div className="space-y-8 p-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Color Palette</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Meridian design tokens — Paper (light) and Espresso (dark). Toggle theme in the toolbar.
        </p>
      </div>

      <Section title="Surfaces">
        <Swatch name="Background" token="--background" bg="var(--background)" border />
        <Swatch name="Card" token="--card" bg="var(--card)" border />
        <Swatch name="Popover" token="--popover" bg="var(--popover)" border />
        <Swatch name="Muted" token="--muted" bg="var(--muted)" border />
        <Swatch name="Secondary" token="--secondary" bg="var(--secondary)" border />
        <Swatch name="Accent" token="--accent" bg="var(--accent)" border />
        <Swatch name="Sidebar" token="--sidebar" bg="var(--sidebar)" border />
      </Section>

      <Section title="Text">
        <Swatch name="Foreground" token="--foreground" bg="var(--foreground)" />
        <Swatch name="Muted Foreground" token="--muted-foreground" bg="var(--muted-foreground)" />
        <Swatch name="Card Foreground" token="--card-foreground" bg="var(--card-foreground)" />
        <Swatch name="Accent Foreground" token="--accent-foreground" bg="var(--accent-foreground)" />
      </Section>

      <Section title="Brand Accent (Jade-Teal)">
        <Swatch
          name="Accent Fill"
          token="--accent-fill"
          bg="var(--accent-fill)"
        />
        <Swatch
          name="Accent Text"
          token="--accent-text"
          bg="var(--accent-text)"
        />
        <Swatch name="Ring" token="--ring" bg="var(--ring)" />
      </Section>

      <Section title="Semantic">
        <PairSwatch
          name="Success"
          bgToken="--success"
          fgToken="--success-foreground"
          bg="var(--success)"
          fg="var(--success-foreground)"
        />
        <Swatch
          name="Destructive"
          token="--destructive"
          bg="var(--destructive)"
        />
      </Section>

      <Section title="Primary / Secondary Pairs">
        <PairSwatch
          name="Primary"
          bgToken="--primary"
          fgToken="--primary-foreground"
          bg="var(--primary)"
          fg="var(--primary-foreground)"
        />
        <PairSwatch
          name="Secondary"
          bgToken="--secondary"
          fgToken="--secondary-foreground"
          bg="var(--secondary)"
          fg="var(--secondary-foreground)"
        />
      </Section>

      <Section title="Borders + Inputs">
        <Swatch name="Border" token="--border" bg="var(--border)" border />
        <Swatch name="Input" token="--input" bg="var(--input)" border />
      </Section>

      <Section title="Sidebar">
        <PairSwatch
          name="Sidebar Primary"
          bgToken="--sidebar-primary"
          fgToken="--sidebar-primary-foreground"
          bg="var(--sidebar-primary)"
          fg="var(--sidebar-primary-foreground)"
        />
        <PairSwatch
          name="Sidebar Accent"
          bgToken="--sidebar-accent"
          fgToken="--sidebar-accent-foreground"
          bg="var(--sidebar-accent)"
          fg="var(--sidebar-accent-foreground)"
        />
        <Swatch name="Sidebar Border" token="--sidebar-border" bg="var(--sidebar-border)" border />
      </Section>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Story meta                                                          */
/* ------------------------------------------------------------------ */

const meta = {
  title: "Foundations/Color Palette",
  component: ColorPalettePage,
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ColorPalettePage>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
