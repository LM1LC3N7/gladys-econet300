# ecoNET300 (chaudières à granulés Plum ecoMAX)

Cette intégration affiche dans Gladys une chaudière à granulés pilotée par un
régulateur **Plum ecoMAX** (Kostrzewa, Hydro-Vacuum, Pereko et d'autres
fabricants), par l'API locale de son module réseau **ecoNET300**, sur votre
réseau, sans passer par econet24.com.

**Jamais testé avec un vrai module** : l'API locale n'est pas documentée par
Plum ; l'intégration suit ecoNET-300-Home-Assistant-Integration (le projet
utilisé par Home Assistant) et ses captures de vrais modules. Sans lien avec
Plum ni avec les fabricants de chaudières. Vos retours sont les bienvenus.

## Ce que vous obtenez

Un appareil Gladys par module ecoNET300, lu toutes les 60 s par défaut :

- températures : chaudière, eau chaude, extérieure, fumées, chargeur, retour,
  ballon tampon (haut et bas), circuits mélangés 1 à 4 ;
- consignes de la chaudière et de l'eau chaude ;
- état de fonctionnement (Arrêt, Allumage, Fonctionnement, Surveillance,
  Extinction, Alarme...) et marche/arrêt de la chaudière ;
- niveau de combustible (%) ;
- alarmes en cours (le nom des plus connues, le code des autres) ;
- état de la liaison (« OK », « ecoNET300 injoignable », un arrêt depuis
  Gladys en cours...).

Une fonctionnalité apparaît dès que le régulateur donne sa valeur (une sonde
absente n'en crée pas) et ne disparaît plus ensuite.

## Configuration

1. Trouvez l'adresse de l'ecoNET300 sur votre réseau (dans votre box ou sur
   l'écran du régulateur), par exemple `192.168.1.50`. Fixez-la si possible
   (bail DHCP réservé).
2. Dans Gladys, ouvrez la configuration de l'intégration et saisissez
   l'adresse (avec `:port` si ce n'est pas 80), le **nom d'utilisateur** et le
   **mot de passe locaux du module** (ceux de son interface web locale, pas
   ceux de votre compte econet24.com). Un mot de passe sans nom d'utilisateur
   est refusé.
3. Enregistrez, puis ajoutez l'appareil depuis l'onglet **Découverte**.

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, et
envoyé seulement à l'ecoNET300 (HTTP Basic, en http simple sur votre réseau ;
https n'est pas pris en charge dans cette version).

Le bouton **Tester la connexion** lit le module une fois, mais jamais plus
tôt que l'intervalle de rafraîchissement après la lecture précédente.

## Les commandes

Par défaut, Gladys ne fait que lire. L'option **Autoriser « Marche » et les
consignes** (désactivée par défaut) permet au tableau de bord, aux scènes et
aux assistants vocaux de :

- mettre la chaudière en **Marche** ;
- changer la **consigne de la chaudière**, dans les bornes que donne le
  régulateur (celles de la dernière lecture si elle a moins de deux
  intervalles, sinon relues avant l'envoi) et entre 20 et 90 °C ;
- changer la **consigne de l'eau chaude**, en degrés entiers, dans les bornes
  du régulateur, entre 20 °C et le plafond configuré : **65 °C par défaut, de
  40 à 65 °C, jamais plus de 65 °C** quoi qu'on saisisse ou que le régulateur
  autorise (risque de brûlure).

Ce ne sont ni des interrupteurs ni des binaires : un « tout éteindre » d'une
scène ou d'un assistant vocal n'atteint pas la chaudière.

Chaque commande relit d'abord le module (son identité et ses valeurs) et
décide sur cette lecture, jamais sur les valeurs gardées en mémoire ; les
commandes arrivées ensemble (une scène) partagent cette relecture et la
lecture qui les confirme, puis partent une à une. Une commande part au plus
tard 3,5 s après le clic, sinon elle est refusée sans rien envoyer (« pas
partie à temps » quand les commandes avant elle ont pris le temps). Elle
n'est annoncée réussie que si une lecture faite après elle, avant 4,3 s,
montre la valeur demandée ; sinon Gladys affiche « envoyée et acceptée, pas
encore appliquée » (ou « envoyée, sans confirmation » si le module n'a pas
répondu), et les lectures de suivi, 5 s et 20 s plus tard, publient la
valeur dès qu'elle apparaît. Au-delà de 4 commandes en attente, elles sont
refusées. Un refus HTTP 401/403 d'une commande ne concerne qu'elle : les
lectures continuent.

Une consigne est refusée tant qu'un arrêt envoyé depuis Gladys tient (voir
ci-dessous) : remettez d'abord la chaudière en « Marche ». Quand /data ne
peut être lu, « Marche » et les consignes sont refusées (un arrêt gardé y
serait inconnu).

## L'arrêt

**« Arrêt »** (la chaudière arrêtée, `BOILER_CONTROL=0`) n'a pas besoin de
l'option. Il part sans attendre une lecture, devant toute autre requête :
une lecture en cours est interrompue, les commandes pas encore envoyées sont
annulées (rien de ce qui a été demandé avant l'arrêt ne part après lui). Ni
l'option, ni les bornes, ni une pause demandée par le module (HTTP 429/5xx),
ni un mot de passe refusé auparavant (un essai), ni /data illisible, ni un
appareil pas encore lu ne le retiennent.

Il est refusé dans ces deux cas seulement :

- la configuration de l'intégration n'est pas valide, ou n'a pas encore pu
  être lue depuis le démarrage de l'intégration (sans adresse ni mot de
  passe, rien ne peut partir) ;
- la dernière lecture a montré un **autre** ecoNET300 à cette adresse (un
  identifiant différent).

Quand il ne peut pas partir (module injoignable, coupure), il est retenté
pendant 250 ms, puis gardé dans /data et renvoyé en tête de chaque lecture
suivante, sans limite, jusqu'à ce qu'il parte : il part donc à la première
lecture qui joint le module (après une pause demandée par le module, ou de
nouveaux identifiants s'ils ont été refusés, les lectures attendant alors), et dès le redémarrage de l'intégration ou un
changement de configuration. Il n'est pas renvoyé à un autre ecoNET300 lu à
l'adresse. Quand le module le refuse en HTTP 401/403 alors qu'il accepte les
lectures, il est renvoyé 2 fois au plus, puis l'état le dit ; un refus dû aux
identifiants (les lectures refusées aussi) ne compte pas, et d'autres
identifiants remettent le compte à zéro. Quand il part sans réponse, Gladys affiche
« arrêt envoyé, sans confirmation ». Quand le module répond autre chose que
« OK », Gladys l'affiche et il n'est pas renvoyé.

Il est annoncé réussi quand une lecture faite après lui montre la chaudière
à l'arrêt, ou en extinction alors qu'elle a été lue en marche juste avant
son départ (une lecture de moins de deux intervalles) ou depuis : l'arrêt est
alors pris. Une chaudière à granulés s'éteint en plusieurs minutes ; le
sélecteur montre « Arrêt » pendant l'extinction. Une fois l'arrêt pris, plus
rien n'est renvoyé. Si une lecture faite après l'arrêt la montre en marche
alors qu'il n'a pas encore été vu pris, l'arrêt est renvoyé, 3 fois au plus.

Quand l'état d'avant est inconnu (module injoignable, redémarrage de
l'intégration, identifiants refusés ou dernière lecture trop ancienne au
départ de l'arrêt) et que la première lecture après lui montre déjà
l'extinction, rien ne prouve qu'il ait pris (ce peut être une extinction
normale) : si la chaudière est ensuite lue en marche, ce n'est pas compté
comme une remise en marche ailleurs, et l'arrêt est renvoyé. Une remise en
marche sur le panneau pendant cette extinction-là peut donc être contredite ;
dès qu'une extinction suit une marche lue, l'arrêt est pris et une nouvelle
remise en marche ne l'est plus.

L'arrêt depuis Gladys est gardé dans /data, sans limite de durée. Il est levé
seulement par un clic sur « Marche » (avec l'option), ou quand, une fois
l'arrêt pris, la chaudière est lue en marche (allumage,
fonctionnement, surveillance..., pas une alarme ni un mode de service) deux
fois de suite (remise en marche sur le panneau ou par l'application).

## État et erreurs

- **Nom d'utilisateur ou mot de passe refusés** (HTTP 401/403 d'une
  lecture) : les lectures s'arrêtent, sans nouvel essai automatique ; enregistrez d'autres
  identifiants ou utilisez « Tester la connexion ».
- **Le module demande de ralentir** (HTTP 429 ou 5xx) : pause de 1 min à 6 h,
  gardée dans /data, pour tout sauf l'arrêt.
- **Module injoignable** : nouvel essai après 1, 2, 5 puis 10 min, jamais plus
  tôt que l'intervalle ; les dernières valeurs restent affichées, l'état de
  la liaison le dit.
- **Un autre ecoNET300 répond à l'adresse** : ses valeurs ne vont jamais sur
  l'appareil créé ; il apparaît comme un nouvel appareil dans Découverte.
- **Bornes non lues** : certains modules ne donnent pas les bornes des
  consignes (`rmCurrentDataParamsEdits`) ; les lectures continuent, les
  consignes sont refusées.

L'identité de l'appareil est une empreinte de l'identifiant (`uid`) du
module ; l'identifiant lui-même, la clé econet24.com et le nom du Wi-Fi que
donne le module ne sont jamais publiés ni gardés.

## Ce qui est gardé dans /data

`econet300-state.json` : une pause en cours, un refus des identifiants (avec
8 bits d'une empreinte salée, de quoi savoir s'ils ont changé, pas de quoi
retrouver un mot de passe), l'heure de la dernière lecture (un redémarrage ne
relit jamais plus tôt que l'intervalle), l'arrêt envoyé depuis Gladys. Aucun
secret.

## Limites connues

- Seuls les régulateurs qui donnent leurs valeurs dans `regParams` sont lus
  (dans les captures de la référence : ecoMAX810P-L, ecoMAX850R2-X,
  ecoMAX860P2-N, ecoMAX860P3-V ; d'autres ecoMAX860 et 920, l'ecoMAX360i,
  les ecoSOL n'y donnent rien) ; les autres ne montrent que leurs alarmes :
  l'état de la liaison le dit.
- Mode été/hiver, circuits mélangés en écriture, puissance du brûleur,
  pompes : pas dans cette version.
- Module lent, mesuré sur un serveur local : une scène « Marche » + deux
  consignes est envoyée et confirmée jusqu'à 700 ms par requête ; à 900 ms,
  les deux premières partent et sont confirmées par les lectures de suivi
  (« pas encore appliquée » à l'écran), la troisième est refusée sans rien
  envoyer (« pas partie à temps »). Une consigne seule est confirmée jusqu'à
  900 ms.

## Crédits

Le protocole local est porté de
[ecoNET-300-Home-Assistant-Integration](https://github.com/jontofront/ecoNET-300-Home-Assistant-Integration)
(jontofront et contributeurs, licence MIT) ; voir THIRD_PARTY_NOTICES.md.
