import Image from 'next/image';
import './Mascot.css';

/** Decorative animation, hidden from assistive technology and pointer events. */
export function Mascot() {
  return (
    <div className="bootr-mascot" aria-hidden="true">
      <div className="bootr-mascot-character">
        <Image src="/bootr-mascot-wave.png" alt="" width={480} height={480} className="bootr-mascot-body" />
        <Image src="/bootr-mascot-wave.png" alt="" width={480} height={480} className="bootr-mascot-arm" />
      </div>
    </div>
  );
}
