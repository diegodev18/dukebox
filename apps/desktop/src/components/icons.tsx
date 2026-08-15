import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react'
import { cn } from '@/lib/utils'
import {
  AlertCircleIcon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Attachment01Icon,
  BookOpen01Icon,
  Cancel01Icon,
  CheckmarkCircle01Icon,
  Copy01Icon,
  Download01Icon,
  File01Icon,
  Folder01Icon,
  GitBranchIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  GlobeIcon as GlobeGlyph,
  PencilEdit01Icon,
  PlusSignIcon,
  Refresh01Icon,
  Search01Icon,
  ServerStack01Icon,
  Settings01Icon,
  TerminalIcon as TerminalGlyph,
  Wrench01Icon,
} from '@hugeicons/core-free-icons'

/**
 * The app's icon set, in one place.
 *
 * Every icon is a Hugeicons drawing. Wrapping them here keeps the size, stroke,
 * and colour conventions of the app in a single file, and gives callers a
 * component they can style the way they would any other element. The agent
 * marks (Claude, Codex, …) are brand marks and stay inline in `AgentIcon`.
 */

export interface IconProps {
  /** Rendered at this many pixels. Hugeicons are drawn on a 24 grid. */
  size?: number
  className?: string
  /** Overrides the icon's own stroke width; rarely needed. */
  strokeWidth?: number
}

function icon(data: IconSvgElement) {
  return function IconComponent({ size = 16, className, ...props }: IconProps) {
    return <HugeiconsIcon icon={data} size={size} className={cn('block', className)} {...props} />
  }
}

/** The app's gear: opens settings from the sidebar and account menu. */
export const SettingsIcon = icon(Settings01Icon)
/** Disclosure chevrons — Hugeicons call the plain chevrons "arrows". */
export const ChevronDownIcon = icon(ArrowDown01Icon)
export const ChevronUpIcon = icon(ArrowUp01Icon)
export const ChevronRightIcon = icon(ArrowRight01Icon)
export const ChevronLeftIcon = icon(ArrowLeft01Icon)
/** The selected row in a menu or picker. */
export const CheckIcon = icon(CheckmarkCircle01Icon)
export const RefreshIcon = icon(Refresh01Icon)
export const PlusIcon = icon(PlusSignIcon)
export const SearchIcon = icon(Search01Icon)
export const BranchIcon = icon(GitBranchIcon)
export const CommitIcon = icon(GitCommitIcon)
export const PullRequestIcon = icon(GitPullRequestIcon)
export const ServerIcon = icon(ServerStack01Icon)
export const FolderIcon = icon(Folder01Icon)
export const FileIcon = icon(File01Icon)
/** Attaching files to a prompt. */
export const AttachIcon = icon(Attachment01Icon)
/** Environment-setup work, shown in the transcript. */
export const SetupIcon = icon(Wrench01Icon)
/** Dismiss or remove, e.g. closing the session header popover. */
export const CloseIcon = icon(Cancel01Icon)
/** Downloading an update. */
export const DownloadIcon = icon(Download01Icon)
/** Sending a prompt. */
export const SendIcon = icon(ArrowUp01Icon)
/** A finished session the person has not opened yet. */
export const BookOpenIcon = icon(BookOpen01Icon)
/** A session that failed, shown in the sidebar nav. */
export const AlertIcon = icon(AlertCircleIcon)
/** Copy a transcript message to the clipboard. */
export const CopyIcon = icon(Copy01Icon)
/** Load a user prompt into the composer to edit and resend. */
export const EditIcon = icon(PencilEdit01Icon)
/** Shell / command tools in the transcript. */
export const TerminalIcon = icon(TerminalGlyph)
/** Network / fetch tools in the transcript. */
export const GlobeIcon = icon(GlobeGlyph)
