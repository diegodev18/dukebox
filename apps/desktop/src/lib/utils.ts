import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge Tailwind classes the way shadcn components expect. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
