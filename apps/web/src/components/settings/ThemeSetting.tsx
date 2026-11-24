import React, { useRef } from "react";
import { ACCENTS, useAccent, useThemePreference, type ThemePreference } from "../../utils/theme";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/**
 * Settings row with a three-way theme choice. "System" follows the OS and switches with it.
 * Uses the same row and segmented-control classes as the task-routing rows in SettingsPanel.
 */
export default function ThemeSetting() {
  const [preference, setPreference] = useThemePreference();
  const groupRef = useRef<HTMLDivElement>(null);

  // Radio-group keyboard pattern: arrows move and select, only the checked option is in the tab order.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = OPTIONS.findIndex((option) => option.value === preference);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % OPTIONS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + OPTIONS.length - 1) % OPTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = OPTIONS.length - 1;
    else return;
    event.preventDefault();
    setPreference(OPTIONS[next].value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <div className="settings-task-list">
      <div className="settings-task">
        <div className="settings-task-text">
          <span className="settings-task-name" id="theme-setting-label">Theme</span>
          <span className="settings-task-desc">System follows your device's light or dark setting.</span>
        </div>
        <div className="settings-task-control">
          <div className="sop-diff-tabs" role="radiogroup" aria-labelledby="theme-setting-label" ref={groupRef} onKeyDown={onKeyDown}>
            {OPTIONS.map(({ value, label }) => {
              const checked = value === preference;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  className={`sop-diff-tab${checked ? " active" : ""}`}
                  onClick={() => setPreference(value)}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <AccentRow />
    </div>
  );
}

/** The accent colour: one labelled swatch per preset in styles/tokens.css, with the same radio-group keys as the theme. */
function AccentRow() {
  const [accent, setAccent] = useAccent();
  const groupRef = useRef<HTMLDivElement>(null);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = ACCENTS.findIndex((option) => option.value === accent);
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % ACCENTS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + ACCENTS.length - 1) % ACCENTS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ACCENTS.length - 1;
    else return;
    event.preventDefault();
    setAccent(ACCENTS[next].value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  };

  return (
    <div className="settings-task">
      <div className="settings-task-text">
        <span className="settings-task-name" id="accent-setting-label">Accent colour</span>
        <span className="settings-task-desc">Used for links, focus outlines, switches and highlights.</span>
      </div>
      <div className="settings-task-control">
        <div className="settings-accents" role="radiogroup" aria-labelledby="accent-setting-label" ref={groupRef} onKeyDown={onKeyDown}>
          {ACCENTS.map(({ value, label }) => {
            const checked = value === accent;
            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={checked}
                tabIndex={checked ? 0 : -1}
                className="settings-accent"
                onClick={() => setAccent(value)}
              >
                <span className={`settings-accent-dot settings-accent-dot--${value}`} aria-hidden="true" />
                {label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
