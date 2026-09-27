import React from "react";
import css from "@/game/ui/pickers/Picker.module.css";

/**
 * The frame every chooser sits in: backdrop, panel, heading and hint line.
 *
 * All four pickers had their own copy of this markup, and the copies had begun
 * to drift. Keyboard handling is the other half of a chooser and lives next
 * door, in usePickerKeys.
 */
export function PickerShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className={css.pickerBackdrop}>
      <div className={css.pickerPanel}>
        <div className={css.pickerTitle}>{title}</div>
        <div className={css.pickerSubtitle}>{subtitle}</div>
        {children}
      </div>
    </div>
  );
}
