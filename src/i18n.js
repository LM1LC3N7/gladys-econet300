// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, operating states,
// alarms, the status of the integration, the answers of the button and the
// command errors. None of them ever carries the address, the user name, the
// password, the uid or a text of the module.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** Joins texts with a space, in both languages. */
export const join = (...parts) =>
  both(parts.map((p) => p.en).join(' '), parts.map((p) => p.fr).join(' '));

export const deviceName = (model) => {
  const name = model || 'ecoMAX';
  return both(`${name} (ecoNET300)`, `${name} (ecoNET300)`);
};

export const FEATURE_NAMES = {
  [F.BOILER_CONTROL]: both('Boiler on/off', 'Marche/arrêt de la chaudière'),
  [F.OPERATION]: both('Operating state', 'État de fonctionnement'),
  [F.BOILER_TEMPERATURE]: both('Boiler temperature', 'Température de la chaudière'),
  [F.BOILER_SETPOINT]: both('Boiler setpoint', 'Consigne de la chaudière'),
  [F.DHW_TEMPERATURE]: both('Hot water temperature', 'Température de l’eau chaude'),
  [F.DHW_SETPOINT]: both('Hot water setpoint', 'Consigne de l’eau chaude'),
  [F.OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [F.FLUE_GAS]: both('Flue gas temperature', 'Température des fumées'),
  [F.FEEDER]: both('Feeder temperature', 'Température du chargeur'),
  [F.RETURN]: both('Return temperature', 'Température de retour'),
  [F.BUFFER_UPPER]: both('Buffer tank top temperature', 'Température haute du ballon tampon'),
  [F.BUFFER_LOWER]: both('Buffer tank bottom temperature', 'Température basse du ballon tampon'),
  [F.MIXER1]: both('Mixing circuit 1 temperature', 'Température du circuit mélangé 1'),
  [F.MIXER2]: both('Mixing circuit 2 temperature', 'Température du circuit mélangé 2'),
  [F.MIXER3]: both('Mixing circuit 3 temperature', 'Température du circuit mélangé 3'),
  [F.MIXER4]: both('Mixing circuit 4 temperature', 'Température du circuit mélangé 4'),
  [F.FUEL]: both('Fuel level', 'Niveau de combustible'),
  [F.ALARMS]: both('Alarms', 'Alarmes'),
  [F.STATUS]: both('Status', 'État de la liaison'),
};

export const CONTROL_NAMES = {
  on: both('On', 'Marche'),
  off: both('Off', 'Arrêt'),
};

/** The operating states (`mode`), as the reference names them. */
export const MODE_NAMES = [
  both('Off', 'Arrêt'),
  both('Stop (standby)', 'Stop (attente)'),
  both('Firing up', 'Allumage'),
  both('Operation', 'Fonctionnement'),
  both('Supervision', 'Surveillance'),
  both('Paused', 'En pause'),
  both('Cleaning', 'Nettoyage'),
  both('Burning off', 'Extinction'),
  both('Alarm', 'Alarme'),
  both('Manual', 'Manuel'),
  both('Unsealing', 'Désobstruction'),
  both('Other', 'Autre'),
  both('Stabilization', 'Stabilisation'),
  both('Purge', 'Purge'),
  both('Flame check', 'Contrôle de flamme'),
  both('Flame losing', 'Perte de flamme'),
  both('Prevention', 'Prévention'),
  both('Grate operation', 'Fonctionnement sur grille'),
  both('Grate supervision', 'Surveillance sur grille'),
  both('Calibration', 'Étalonnage'),
  both('Maintenance', 'Maintien'),
  both('Afterburning', 'Post-combustion'),
  both('Chimney sweep', 'Ramonage'),
  both('Heating', 'Chauffe'),
  both('Door open', 'Porte ouverte'),
  both('Cooling', 'Refroidissement'),
  both('Safe mode', 'Mode sécurité'),
];

/** The alarm codes the reference names (rmAlarmsNames of an ecoMAX810P-L). */
const ALARM_NAMES = {
  0: both('power outage', 'coupure de courant'),
  1: both('boiler temperature sensor damaged', 'sonde de chaudière endommagée'),
  2: both('maximum boiler temperature exceeded', 'température maximale de chaudière dépassée'),
  3: both('feeder temperature sensor damaged', 'sonde du chargeur endommagée'),
  4: both('maximum feeder temperature exceeded', 'température maximale du chargeur dépassée'),
  5: both('flue gas sensor damaged', 'sonde des fumées endommagée'),
  7: both('firing up failed, empty the ash pan', 'échec de l’allumage, videz le cendrier'),
  11: both('fan failure', 'panne du ventilateur'),
  255: both('alarm continues', 'alarme persistante'),
};

const alarmName = (code) => ALARM_NAMES[code] ?? both(`code ${code}`, `code ${code}`);

export const ALARM_TEXTS = {
  none: both('No alarm', 'Aucune alarme'),
  list: (codes, more) => {
    const names = codes.map(alarmName);
    const tail = more > 0 ? both(` (+${more})`, ` (+${more})`) : both('', '');
    return both(
      `Alarm: ${names.map((n) => n.en).join('; ')}${tail.en}`,
      `Alarme : ${names.map((n) => n.fr).join(' ; ')}${tail.fr}`,
    );
  },
};

export const STATUS_TEXTS = {
  online: both('OK', 'OK'),
  offline: both('ecoNET300 unreachable', 'ecoNET300 injoignable'),
  foreign: both(
    'Another ecoNET300 answers at this address',
    'Un autre ecoNET300 répond à cette adresse',
  ),
  unknown: both('State not read', 'État non lu'),
  stopUnsent: both(
    'Stop from Gladys not sent yet: sent again at each read',
    'Arrêt depuis Gladys pas encore envoyé : renvoyé à chaque lecture',
  ),
  stopWaitsCredentials: both(
    'A stop from Gladys waits: sent as soon as other credentials are saved or the button gets through',
    'Un arrêt depuis Gladys attend : envoyé dès que d’autres identifiants sont enregistrés ou que le bouton passe',
  ),
  stopRefused: both(
    'Stop from Gladys refused 3 times by the ecoNET300 (HTTP 401/403): not sent again',
    'Arrêt depuis Gladys refusé 3 fois par l’ecoNET300 (HTTP 401/403) : plus renvoyé',
  ),
  stopUnapplied: both(
    'Stop from Gladys sent but the boiler still runs',
    'Arrêt depuis Gladys envoyé mais la chaudière fonctionne encore',
  ),
  stopPending: both('Stopping (stop from Gladys)', 'Arrêt en cours (arrêt depuis Gladys)'),
  stopped: both('Stopped from Gladys', 'Arrêtée depuis Gladys'),
};

/** The connection status texts of the configuration screen. */
export const T = {
  connecting: both('Connecting to the ecoNET300...', 'Connexion à l’ecoNET300...'),
  configWait: (wait) =>
    both(
      `Configuration not read from Gladys; next try in ${wait.en}`,
      `Configuration non lue depuis Gladys ; nouvel essai dans ${wait.fr}`,
    ),
  problem: (problem) => PROBLEMS[problem] ?? PROBLEMS.badAddress,
  refused: both(
    'The ecoNET300 refused the user name or the password: stopped, no automatic retry. Check them, save, or use "Test the connection".',
    'L’ecoNET300 a refusé le nom d’utilisateur ou le mot de passe : arrêt, sans nouvel essai automatique. Vérifiez-les, enregistrez, ou utilisez « Tester la connexion ».',
  ),
  busy: (wait) =>
    both(
      `The ecoNET300 asks to slow down (HTTP 429/5xx): paused, next read in ${wait.en}`,
      `L’ecoNET300 demande de ralentir (HTTP 429/5xx) : pause, prochaine lecture dans ${wait.fr}`,
    ),
  unreachable: (reason, wait) =>
    both(
      `ecoNET300 not read (${reason}); next try in ${wait.en}`,
      `ecoNET300 non lu (${reason}) ; nouvel essai dans ${wait.fr}`,
    ),
  noIdentity: both(
    'The ecoNET300 answers without its identifier (uid): values not shown',
    'L’ecoNET300 répond sans son identifiant (uid) : valeurs non affichées',
  ),
  noValues: both(
    'Connected, but this controller gives no current values (regParams): not supported yet',
    'Connecté, mais ce régulateur ne donne pas de valeurs courantes (regParams) : pas encore pris en charge',
  ),
  connected: (model) =>
    both(`Connected to ${model ?? 'the ecoNET300'}`, `Connecté à ${model ?? 'l’ecoNET300'}`),
  nextRead: (wait) => both(`Next read in ${wait.en}`, `Prochaine lecture dans ${wait.fr}`),
  withNote: (text, note) => {
    const bare = (t) => t.replace(/\.$/, '');
    return both(`${bare(text.en)}. ${bare(note.en)}.`, `${bare(text.fr)}. ${bare(note.fr)}.`);
  },
  unreadable: both(
    '/data unreadable: nothing is saved, the start and the setpoints are refused.',
    '/data illisible : rien n’est enregistré, la marche et les consignes sont refusées.',
  ),
  test: {
    next: (wait) =>
      both(
        `Read less than an interval ago: next possible in ${wait.en}.`,
        `Lu il y a moins d’un intervalle : prochain essai possible dans ${wait.fr}.`,
      ),
  },
};

const PROBLEMS = {
  noAddress: both(
    'Enter the address of the ecoNET300, the user name and the password, then save.',
    'Saisissez l’adresse de l’ecoNET300, le nom d’utilisateur et le mot de passe, puis enregistrez.',
  ),
  https: both(
    'The ecoNET300 answers in plain http: enter its address without https://.',
    'L’ecoNET300 répond en http simple : saisissez son adresse sans https://.',
  ),
  badAddress: both(
    'Address not valid: an IPv4 address or a host name, with an optional port (192.168.1.50 or 192.168.1.50:8080).',
    'Adresse non valide : une adresse IPv4 ou un nom d’hôte, avec un port facultatif (192.168.1.50 ou 192.168.1.50:8080).',
  ),
  specialAddress: both(
    'This address is a network, broadcast or multicast address: enter the address of the ecoNET300.',
    'Cette adresse est une adresse de réseau, de diffusion ou de multidiffusion : saisissez l’adresse de l’ecoNET300.',
  ),
  noUsername: both(
    'Enter the user name of the ecoNET300 (a password alone is refused).',
    'Saisissez le nom d’utilisateur de l’ecoNET300 (un mot de passe seul est refusé).',
  ),
  badUsername: both(
    'User name not valid (64 characters at most, Latin letters, no control character).',
    'Nom d’utilisateur non valide (64 caractères au plus, lettres latines, sans caractère de contrôle).',
  ),
  noPassword: both(
    'Enter the password of the ecoNET300.',
    'Saisissez le mot de passe de l’ecoNET300.',
  ),
  badPassword: both(
    'Password not valid (128 characters at most, Latin letters, no control character).',
    'Mot de passe non valide (128 caractères au plus, lettres latines, sans caractère de contrôle).',
  ),
};

/** The refusals of the commands (the error Gladys shows). */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are off: allow them in the configuration of the integration ("Off" needs no option).',
    'Les commandes sont désactivées : autorisez-les dans la configuration de l’intégration (« Arrêt » n’a pas besoin d’option).',
  ),
  badControl: both('Choose "On" or "Off".', 'Choisissez « Marche » ou « Arrêt ».'),
  badNumber: both('Not a number.', 'Ce n’est pas un nombre.'),
  badWhole: both('Whole degrees only.', 'Degrés entiers seulement.'),
  outOfRange: (low, high) =>
    both(`Out of range: ${low} to ${high} °C.`, `Hors limites : de ${low} à ${high} °C.`),
  noConfig: both(
    'The configuration of the integration is not read or not valid: nothing sent.',
    'La configuration de l’intégration n’est pas lue ou pas valide : rien envoyé.',
  ),
  foreign: both(
    'Another ecoNET300 answers at this address: nothing sent.',
    'Un autre ecoNET300 répond à cette adresse : rien envoyé.',
  ),
  noIdentity: both(
    'The identity of the ecoNET300 could not be read: nothing sent.',
    'L’identité de l’ecoNET300 n’a pas pu être lue : rien envoyé.',
  ),
  refusedAccount: both(
    'The ecoNET300 refused the user name or the password: nothing sent.',
    'L’ecoNET300 a refusé le nom d’utilisateur ou le mot de passe : rien envoyé.',
  ),
  paused: both(
    'The ecoNET300 asked to slow down (HTTP 429/5xx): nothing sent during the pause.',
    'L’ecoNET300 a demandé de ralentir (HTTP 429/5xx) : rien envoyé pendant la pause.',
  ),
  queueFull: both(
    'Too many commands waiting: nothing sent.',
    'Trop de commandes en attente : rien envoyé.',
  ),
  stopped: both(
    'A stop was sent since: this command was not sent.',
    'Un arrêt a été envoyé depuis : cette commande n’a pas été envoyée.',
  ),
  stopHolds: both(
    'The boiler was stopped from Gladys: switch it "On" first (nothing sent).',
    'La chaudière a été arrêtée depuis Gladys : remettez-la en « Marche » d’abord (rien envoyé).',
  ),
  unreadableData: both(
    '/data cannot be read or written: nothing sent.',
    '/data ne peut être lu ou écrit : rien envoyé.',
  ),
  queueLate: both(
    'Not sent in time, the commands before it took the time: nothing sent.',
    'Pas partie à temps, les commandes avant elle ont pris le temps : rien envoyé.',
  ),
  tooSlow: both(
    'The ecoNET300 did not answer in time: nothing sent.',
    'L’ecoNET300 n’a pas répondu à temps : rien envoyé.',
  ),
  notRead: (reason) =>
    both(
      `The ecoNET300 could not be read (${reason}): nothing sent.`,
      `L’ecoNET300 n’a pas pu être lu (${reason}) : rien envoyé.`,
    ),
  missingValue: both(
    'The ecoNET300 does not give this value: nothing sent.',
    'L’ecoNET300 ne donne pas cette valeur : rien envoyé.',
  ),
  noLimits: both(
    'The ecoNET300 does not give the bounds of this setpoint: nothing sent.',
    'L’ecoNET300 ne donne pas les bornes de cette consigne : rien envoyé.',
  ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Rien envoyé (${reason}).`),
  rejected: (result) =>
    both(
      `The ecoNET300 refused the command (${result}).`,
      `L’ecoNET300 a refusé la commande (${result}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): checked by the next reads.`,
      `Envoyée, sans confirmation (${reason}) : vérifiée par les prochaines lectures.`,
    ),
  notYetApplied: both(
    'Sent and accepted, not applied yet: checked by the next reads.',
    'Envoyée et acceptée, pas encore appliquée : vérifiée par les prochaines lectures.',
  ),
  stopUnsent: (reason) =>
    both(
      `Stop not sent (${reason}): sent again at each read until it leaves.`,
      `Arrêt non envoyé (${reason}) : renvoyé à chaque lecture jusqu’à ce qu’il parte.`,
    ),
  stopAfterCredentials: (reason) =>
    both(
      `Stop not sent (${reason}, credentials refused): sent once other credentials are saved or the button gets through.`,
      `Arrêt non envoyé (${reason}, identifiants refusés) : envoyé dès que d’autres identifiants sont enregistrés ou que le bouton passe.`,
    ),
  stopUnconfirmed: (reason) =>
    both(
      `Stop sent, without confirmation (${reason}): checked by the next reads.`,
      `Arrêt envoyé, sans confirmation (${reason}) : vérifié par les prochaines lectures.`,
    ),
  stopNotYet: both(
    'Stop sent and accepted; the boiler has not shown it yet: checked by the next reads.',
    'Arrêt envoyé et accepté ; la chaudière ne l’indique pas encore : vérifié par les prochaines lectures.',
  ),
};
