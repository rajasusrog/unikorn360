import { localReceiverFeedName } from '../layers/localAdsb/feedNames.js';
import { msg, t, tn } from '../i18n/index.js';
import { formatQuantity } from './unitLabels.js';

/**
 * Pure presentation of the Local RTL-SDR card in the Radio panel. Receives the
 * receiver session snapshot and returns what each control should show.
 */

// Receiver status codes shown on the connection chip and the connect button.
const STATUS_LABELS = Object.freeze({
  idle: msg('IDLE'),
  connecting: msg('CONNECTING'),
  tuning: msg('TUNING'),
  streaming: msg('STREAMING'),
  error: msg('ERROR'),
  unsupported: msg('UNSUPPORTED'),
});

function statusLabel(status) {
  const key = String(status || 'idle');
  return STATUS_LABELS[key] ? t(STATUS_LABELS[key]) : key.toUpperCase();
}

/**
 * Text for a numeric gain option: the option value stays the machine value
 * ("28.0"); only the label follows the locale ("28,0 дБ").
 */
export function localSdrGainOptionLabel(value) {
  const gain = Number(value);
  if (!Number.isFinite(gain)) return String(value);
  return formatQuantity(gain, 'dB', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function formatGain(gain) {
  return gain === 'auto' || !Number.isFinite(gain) ? 'auto' : gain.toFixed(1);
}

function formatIq(state) {
  return Number.isFinite(state.iqLevelDbfs)
    ? `${state.iqLevelDbfs.toFixed(1)} dBFS`
    : '--';
}

function statusText(state) {
  const fmActive = state.mode === 'fm';
  const iqStatus =
    state.samplesPerSecond > 0
      ? `${(state.samplesPerSecond / 1_000_000).toFixed(2)} MS/s IQ`
      : t('waiting for IQ');
  const device = state.deviceLabel ? ` · ${state.deviceLabel}` : '';
  if (state.connected && !fmActive) {
    const decoded = tn(
      state.decodedMessages,
      '{count} message',
      '{count} messages',
    );
    return `${state.message}${device} · ${iqStatus} · ${decoded}`;
  }
  const detail = state.seeking
    ? state.seekMessage
    : state.seekMessage || state.message;
  if (state.connected && fmActive) {
    const workerStatus =
      state.workerBlocks > 0
        ? tn(state.workerBlocks, 'DSP {count} block', 'DSP {count} blocks')
        : t('DSP waiting');
    const rfStatus = `RF ${formatIq(state)}`;
    const audioSignal = Number.isFinite(state.audioLevelDbfs)
      ? t('{level} dBFS audio', { level: state.audioLevelDbfs.toFixed(1) })
      : t('audio signal --');
    const audio = t('audio {state}', { state: state.audioState });
    return `${detail}${device} · ${iqStatus} · ${workerStatus} · ${rfStatus} · ${audioSignal} · ${audio}`;
  }
  return detail;
}

/**
 * Derive the card's control states from one receiver snapshot.
 * @param {object} state SdrController.getState() snapshot.
 * @returns {object} Control presentation.
 */
export function localSdrCardView(state) {
  const transitional =
    state.status === 'connecting' || state.status === 'tuning';
  const fmActive = state.mode === 'fm';
  const adsbActive = state.mode === 'adsb';
  const fmInteractive =
    state.connected && fmActive && state.status === 'streaming';
  return {
    connectionLabel: state.connected
      ? adsbActive
        ? tn(state.aircraftHeard || 0, '{count} HEARD', '{count} HEARD')
        : t('STREAMING')
      : statusLabel(state.status),
    connectionActive: Boolean(state.connected),
    connectLabel: transitional
      ? statusLabel(state.status)
      : state.connected
        ? t('DISCONNECT')
        : t('CONNECT'),
    connectDisabled: transitional || !state.webUsbSupported,
    connectPressed: Boolean(state.connected),
    fmActive,
    adsbActive,
    modeDisabled: transitional,
    locateLabel:
      state.locationStatus === 'requesting'
        ? t('LOCATING…')
        : state.locationStatus === 'ready'
          ? t('LOCATED')
          : t('LOCATE'),
    locateDisabled: state.locationStatus === 'requesting',
    locateActive: state.locationStatus === 'ready',
    changeDeviceDisabled: transitional || !state.webUsbSupported,
    gainValue: formatGain(state.gain),
    gainDisabled: transitional,
    statsHidden: !(adsbActive && state.connected),
    stats: {
      rate: Number.isFinite(state.messagesPerSecond)
        ? state.messagesPerSecond.toFixed(1)
        : '--',
      heard: String(state.aircraftHeard || 0),
      positioned: String(state.aircraftPositioned || 0),
      iq: formatIq(state),
    },
    frequencyDisabled: !fmActive || transitional,
    frequencyValue: fmActive
      ? (state.frequencyHz / 1_000_000).toFixed(1)
      : null,
    tuneDisabled: !state.connected || !fmActive || transitional,
    seekDisabled: !fmInteractive || Boolean(state.seeking),
    volumePercent: Math.round((Number(state.volume) || 0) * 100),
    volumeDisabled: !fmActive,
    statusText: statusText(state),
    statusError: state.status === 'error' || state.status === 'unsupported',
  };
}

/**
 * Whether the receiver is producing FM audio (the state that must not overlap
 * internet-radio playback).
 * @param {object} state SdrController.getState() snapshot.
 * @returns {boolean}
 */
export function localSdrFmAudioActive(state) {
  return Boolean(
    state?.connected && state.mode === 'fm' && state.status === 'streaming',
  );
}

/**
 * Whether internet radio is loading or playing a station.
 * @param {object} state Radio UI state.
 * @returns {boolean}
 */
export function internetRadioAudioActive(state) {
  return ['loading', 'buffering', 'playing'].includes(state?.audioState);
}

/**
 * One-line decoder-feed summary for the card, or null when the server has no
 * feed configured. Statuses show while Local ADS-B polls the feeds; otherwise
 * the line names the configured bands.
 * @param {object|null} feedState Local receiver feed session snapshot.
 * @returns {string|null}
 */
export function localSdrFeedLine(feedState) {
  const feeds = feedState?.configured === true ? feedState.feeds : null;
  if (!Array.isArray(feeds) || !feeds.length) return null;
  const names = feeds.map((feed) => {
    const name = localReceiverFeedName(feed, feeds);
    return feedState.polling || feed?.status === 'invalid'
      ? `${name} ${feed?.status || 'unreachable'}`
      : name;
  });
  const suffix = feedState.polling ? '' : ' · read while Local ADS-B is on';
  return `Decoder feeds: ${names.join(' · ')}${suffix}`;
}
