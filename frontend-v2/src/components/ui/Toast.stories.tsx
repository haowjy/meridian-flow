import type { Meta, StoryObj } from "@storybook/react-vite"
import { toast } from "sonner"
import { Toaster } from "./sonner"
import { Button } from "./button"

const meta = {
  title: "UI/Toast",
  component: Toaster,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <>
        <Story />
        <Toaster />
      </>
    ),
  ],
} satisfies Meta<typeof Toaster>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Button onClick={() => toast("Chapter saved successfully.")}>
      Show Toast
    </Button>
  ),
}

export const Success: Story = {
  render: () => (
    <Button
      onClick={() => toast.success("Chapter published!", { description: "Your readers can now see the latest chapter." })}
    >
      Success Toast
    </Button>
  ),
}

export const Error: Story = {
  render: () => (
    <Button
      variant="destructive"
      onClick={() => toast.error("Failed to save.", { description: "Please check your connection and try again." })}
    >
      Error Toast
    </Button>
  ),
}

export const Warning: Story = {
  render: () => (
    <Button
      variant="outline"
      onClick={() => toast.warning("Unsaved changes", { description: "You have unsaved changes that will be lost." })}
    >
      Warning Toast
    </Button>
  ),
}

export const Info: Story = {
  render: () => (
    <Button
      variant="secondary"
      onClick={() => toast.info("New version available", { description: "A new version of the editor is available." })}
    >
      Info Toast
    </Button>
  ),
}

export const WithAction: Story = {
  render: () => (
    <Button
      onClick={() =>
        toast("Chapter deleted.", {
          action: {
            label: "Undo",
            onClick: () => toast.success("Restored!"),
          },
        })
      }
    >
      Toast with Action
    </Button>
  ),
}

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-3">
      <Button onClick={() => toast("Default message")}>Default</Button>
      <Button onClick={() => toast.success("Success!")}>Success</Button>
      <Button onClick={() => toast.error("Error!")}>Error</Button>
      <Button onClick={() => toast.warning("Warning!")}>Warning</Button>
      <Button onClick={() => toast.info("Info")}>Info</Button>
      <Button
        onClick={() =>
          toast.promise(
            new Promise((resolve) => setTimeout(resolve, 2000)),
            {
              loading: "Saving...",
              success: "Saved!",
              error: "Failed to save.",
            }
          )
        }
      >
        Promise
      </Button>
    </div>
  ),
}
