import { wikiIconFile } from '@wom/shared';
import { type JSX, useState } from 'react';
import styles from './Icon.module.css';

type IconProps = {
  /** The square it sits in, in pixels: a smaller icon is centered, a larger one scaled down. */
  size: number;
  /** For an icon beside its printed name: screen readers skip it rather than say the name twice. */
  decorative?: boolean;
} & ({ kind: 'skill' | 'boss'; name: string } | { kind: 'item'; id: number; name: string });

/**
 * A game icon, which the server fetches once and keeps; pixel art stays sharp when scaled. An
 * icon that can't be loaded (the wiki has none for some bosses) leaves its square empty.
 */
export function Icon(props: IconProps): JSX.Element {
  const src =
    props.kind === 'item'
      ? `/api/icons/item/${props.id}`
      : `/api/icons/wiki/${encodeURIComponent(wikiIconFile(props.name, props.kind))}`;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const square = { width: props.size, height: props.size };
  if (failedSrc === src) {
    return props.decorative ? (
      <span aria-hidden="true" className={styles.square} style={square} />
    ) : (
      <span role="img" aria-label={props.name} className={styles.square} style={square} />
    );
  }
  return (
    <span className={styles.square} style={square}>
      <img
        src={src}
        alt={props.decorative ? '' : props.name}
        loading="lazy"
        className={styles.icon}
        onError={() => setFailedSrc(src)}
      />
    </span>
  );
}
