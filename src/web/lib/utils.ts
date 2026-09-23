import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

type UndefinedFiltered<T extends object> = {
  [Key in keyof T as undefined extends T[Key] ? Key : never]?: Exclude<T[Key], undefined>;
} & {
  [Key in keyof T as undefined extends T[Key] ? never : Key]: T[Key];
};

export function omitUndefinedProps<T extends object>(props: T): UndefinedFiltered<T> {
  const definedProps = Object.fromEntries(
    Object.entries(props).filter(([, value]) => value !== undefined),
  );
  return definedProps as UndefinedFiltered<T>;
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
