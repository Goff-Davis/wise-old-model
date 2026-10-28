import { formatNumber, type Overview } from '@wom/shared';
import type { JSX } from 'react';
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

/**
 * The skills as the in-game stats tab shows them: stone tiles in three columns, each with the
 * skill's icon, name and level, and the total level under the grid. Skills come in the order
 * given (orderSkills puts them in the tab's order).
 */
export function StatsTiles(props: {
  skills: Overview['skills'];
  totalLevel: number | null;
}): JSX.Element {
  return (
    <div className={styles.stats}>
      <ul className={styles.grid} aria-label="Skills">
        {props.skills.map((skill) => (
          <li
            key={skill.name}
            className={styles.tile}
            title={skill.xp === null ? 'No level on the hiscores' : `${formatNumber(skill.xp)} XP`}
          >
            <Icon kind="skill" name={skill.name} size={24} decorative />
            <span className={styles.name}>{skill.name}</span>
            <Level value={skill.level} />
          </li>
        ))}
      </ul>
      <p className={styles.total}>
        <span className={styles.name}>Total level</span>
        <Level value={props.totalLevel} />
      </p>
    </div>
  );
}
