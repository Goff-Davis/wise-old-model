import { formatNumber, type Overview } from '@wom/shared';
import { type JSX, useState } from 'react';
import { Icon } from './Icon.tsx';
import styles from './StatsTiles.module.css';

/** A level, or a dash (read out as "unknown") when the hiscores give none. */
function Level(props: { value: number | null }): JSX.Element {
  return (
    <span className={styles.level}>
      {props.value === null ? (
        <>
          <span aria-hidden="true">–</span>
          <span className="visually-hidden">unknown</span>
        </>
      ) : (
        formatNumber(props.value)
      )}
    </span>
  );
}

type Skill = Overview['skills'][number];

/** What the line under the grid says of a picked skill. */
function skillDetail(skill: Skill): string {
  return skill.level === null || skill.xp === null
    ? `${skill.name}: not on the hiscores.`
    : `${skill.name}: level ${formatNumber(skill.level)}, ${formatNumber(skill.xp)} experience (XP).`;
}

/**
 * The skills as the in-game stats tab shows them: stone tiles in three columns, each with the
 * skill's icon, name and level, and the total level under the grid. Skills come in the order
 * given (orderSkills puts them in the tab's order). Picking a tile says its experience on a line
 * below, where keys and touch can reach it as well as a mouse.
 */
export function StatsTiles(props: {
  skills: Overview['skills'];
  totalLevel: number | null;
}): JSX.Element {
  const [picked, setPicked] = useState<string | null>(null);
  const skill = props.skills.find((each) => each.name === picked);
  return (
    <div className={styles.withDetail}>
      <div className={styles.stats}>
        <ul className={styles.grid} aria-label="Skills">
          {props.skills.map((each) => (
            <li key={each.name}>
              {/* The spaces and "level" make its name "Attack level 90"; the grid drops the spaces. */}
              <button
                type="button"
                className={styles.tile}
                aria-pressed={each.name === picked}
                onClick={() => setPicked(each.name)}
              >
                <Icon kind="skill" name={each.name} size={24} decorative />
                <span className={styles.name}>{each.name}</span>{' '}
                <span className="visually-hidden">level</span> <Level value={each.level} />
              </button>
            </li>
          ))}
        </ul>
        <p className={styles.total}>
          <span className={styles.name}>Total level</span>
          <Level value={props.totalLevel} />
        </p>
      </div>
      {/* Under the frame, on the page's own background. */}
      <p className={styles.detail} aria-live="polite">
        {skill ? skillDetail(skill) : 'Pick a skill to see its experience (XP).'}
      </p>
    </div>
  );
}
