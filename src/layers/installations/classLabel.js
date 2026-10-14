import { t } from '../../i18n/index.js';

/**
 * An installation class as a map card shows it: AIRFIELD, NAVAL BASE…, in
 * the UI language. The class itself stays an English identifier in data.
 * @param {string} klass
 * @returns {string}
 */
export function installationClassLabel(klass) {
  const key = String(klass || 'installation');
  switch (key) {
    case 'airfield':
      return t('AIRFIELD', { context: 'installation class' });
    case 'naval_base':
      return t('NAVAL BASE', { context: 'installation class' });
    case 'range':
      return t('RANGE', { context: 'installation class' });
    case 'military_land':
      return t('MILITARY LAND', { context: 'installation class' });
    case 'base':
      return t('BASE', { context: 'installation class' });
    case 'places_candidate':
      return t('PLACES CANDIDATE', { context: 'installation class' });
    case 'installation':
      return t('INSTALLATION', { context: 'installation class' });
    default:
      return key.replaceAll('_', ' ').toUpperCase();
  }
}
