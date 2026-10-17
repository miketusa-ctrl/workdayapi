// Holiday RULES for each supported country, written by WorkdayAPI from official government sources
// (see docs/DATA-LICENSE.md for the source list). No third-party holiday dataset is bundled.
//
// Each country's build(y) returns entries for calendar year y:
//   { n: dayNumber, name, local?, type?: 'public' | 'bank' | 'observance', sub?: 'fri_mon' | 'next' | 'next_sun',
//     regions?: [ISO 3166-2 codes], chrono?: true }
// type   public     = statutory public holiday (not a business day)
//        bank       = not a statutory holiday, but banks / most businesses are closed by law or settled
//                     practice (not a business day by default; see ?types=public to ignore these)
//        observance = listed for information only; it IS a business day
// sub    fri_mon    = Saturday -> preceding Friday, Sunday -> following Monday (US federal rule)
//        next       = Saturday/Sunday -> next weekday not already a holiday (UK/AU/NZ "substitute day")
//        next_sun   = Sunday only -> next day that is not already a holiday (ZA Public Holidays Act s.2)
// regions = holiday applies only in these subdivisions (country-wide when absent).
import { dn, easter, nthWeekday, onOrAfter, onOrBefore, weekday } from './dates.js';

const SUN = 0, MON = 1, THU = 4, FRI = 5, SAT = 6;
const H = (n, name, local, extra = {}) => ({ n, name, ...(local ? { local } : {}), ...extra });
const E = (y, off) => easter(y) + off; // Easter-relative

export const COUNTRIES = {
  US: {
    name: 'United States', scope: 'Federal holidays (5 U.S.C. 6103; OPM observed-date rule)',
    sources: [
      'https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/',
      'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title5-section6103&num=0&edition=prelim',
    ],
    notes: 'Saturday holidays are observed the preceding Friday and Sunday holidays the following Monday (federal employees). Inauguration Day (DC area only), one-off executive-order closures and state holidays are not included.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", null, { sub: 'fri_mon' }),
      H(nthWeekday(y, 1, MON, 3), 'Birthday of Martin Luther King, Jr.'),
      H(nthWeekday(y, 2, MON, 3), "Washington's Birthday"),
      H(nthWeekday(y, 5, MON, -1), 'Memorial Day'),
      ...(y >= 2021 ? [H(dn(y, 6, 19), 'Juneteenth National Independence Day', null, { sub: 'fri_mon' })] : []),
      H(dn(y, 7, 4), 'Independence Day', null, { sub: 'fri_mon' }),
      H(nthWeekday(y, 9, MON, 1), 'Labor Day'),
      H(nthWeekday(y, 10, MON, 2), 'Columbus Day'),
      H(dn(y, 11, 11), 'Veterans Day', null, { sub: 'fri_mon' }),
      H(nthWeekday(y, 11, THU, 4), 'Thanksgiving Day'),
      H(dn(y, 12, 25), 'Christmas Day', null, { sub: 'fri_mon' }),
    ],
  },

  CA: {
    name: 'Canada', scope: 'Federal general holidays (Canada Labour Code s.166; substitute days per s.195)',
    sources: [
      'https://laws-lois.justice.gc.ca/eng/acts/L-2/section-166.html',
      'https://laws-lois.justice.gc.ca/eng/acts/L-2/page-27.html',
      'https://www.canada.ca/en/public-services-procurement/services/pay-pension/pay-administration/access-update-pay-details/pay-changes-in-your-life/taking-leave/statutory-holiday-pay.html',
    ],
    notes: 'Federal holidays only; provincial holidays (Family Day, Civic Holiday, Saint-Jean-Baptiste, etc.) are not included. Holidays falling on a weekend move to the next weekday (federal practice). Easter Monday is a federal public-service holiday only, so it is listed as an observance (business day).',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", "Jour de l'An", { sub: 'next' }),
      H(E(y, -2), 'Good Friday', 'Vendredi saint'),
      H(E(y, 1), 'Easter Monday', 'Lundi de Pâques', { type: 'observance' }),
      H(onOrBefore(y, 5, 24, MON), 'Victoria Day', 'Fête de la Reine'),
      H(dn(y, 7, 1), 'Canada Day', 'Fête du Canada', { sub: 'next' }),
      H(nthWeekday(y, 9, MON, 1), 'Labour Day', 'Fête du travail'),
      ...(y >= 2021 ? [H(dn(y, 9, 30), 'National Day for Truth and Reconciliation', 'Journée nationale de la vérité et de la réconciliation', { sub: 'next' })] : []),
      H(nthWeekday(y, 10, MON, 2), 'Thanksgiving', "Action de grâce"),
      H(dn(y, 11, 11), 'Remembrance Day', 'Jour du Souvenir', { sub: 'next' }),
      H(dn(y, 12, 25), 'Christmas Day', 'Noël', { sub: 'next' }),
      H(dn(y, 12, 26), 'Boxing Day', 'Lendemain de Noël', { sub: 'next' }),
    ],
  },

  GB: {
    name: 'United Kingdom', scope: 'Bank holidays (gov.uk), per nation',
    regions: { 'GB-ENG': 'England', 'GB-WLS': 'Wales', 'GB-SCT': 'Scotland', 'GB-NIR': 'Northern Ireland' },
    defaultRegion: 'GB-ENG',
    sources: ['https://www.gov.uk/bank-holidays', 'https://www.gov.uk/bank-holidays.json'],
    notes: 'Without ?region= the England and Wales calendar (GB-ENG) is used. Substitute days follow gov.uk.',
    build: (y) => {
      const EW = ['GB-ENG', 'GB-WLS'], ALL = ['GB-ENG', 'GB-WLS', 'GB-SCT', 'GB-NIR'], EWN = ['GB-ENG', 'GB-WLS', 'GB-NIR'];
      const out = [
        H(dn(y, 1, 1), "New Year's Day", null, { sub: 'next', regions: EWN }),
        H(dn(y, 1, 1), "New Year's Day", null, { sub: 'next', regions: ['GB-SCT'], chrono: true }),
        H(dn(y, 1, 2), '2nd January', null, { sub: 'next', regions: ['GB-SCT'], chrono: true }),
        H(dn(y, 3, 17), "St Patrick's Day", null, { sub: 'next', regions: ['GB-NIR'] }),
        H(E(y, -2), 'Good Friday', null, { regions: ALL }),
        H(E(y, 1), 'Easter Monday', null, { regions: EWN }),
        H(y === 2020 ? dn(2020, 5, 8) : nthWeekday(y, 5, MON, 1), 'Early May bank holiday', null, { regions: ALL }),
        H(y === 2022 ? dn(2022, 6, 2) : nthWeekday(y, 5, MON, -1), 'Spring bank holiday', null, { regions: ALL }),
        H(dn(y, 7, 12), 'Battle of the Boyne (Orangemen’s Day)', null, { sub: 'next', regions: ['GB-NIR'] }),
        H(nthWeekday(y, 8, MON, 1), 'Summer bank holiday', null, { regions: ['GB-SCT'] }),
        H(nthWeekday(y, 8, MON, -1), 'Summer bank holiday', null, { regions: EWN }),
        H(dn(y, 11, 30), 'St Andrew’s Day', null, { sub: 'next', regions: ['GB-SCT'] }),
        H(dn(y, 12, 25), 'Christmas Day', null, { sub: 'next', regions: ALL }),
        H(dn(y, 12, 26), 'Boxing Day', null, { sub: 'next', regions: ALL }),
      ];
      if (y === 2022) out.push(
        H(dn(2022, 6, 3), 'Platinum Jubilee bank holiday', null, { regions: ALL }),
        H(dn(2022, 9, 19), 'Bank Holiday for the State Funeral of Queen Elizabeth II', null, { regions: ALL }),
      );
      if (y === 2023) out.push(H(dn(2023, 5, 8), 'Bank holiday for the coronation of King Charles III', null, { regions: ALL }));
      if (y === 2026) out.push(H(dn(2026, 6, 15), 'World Cup bank holiday', null, { regions: ['GB-SCT'] })); // one-off, gov.uk
      return out;
    },
  },

  IE: {
    name: 'Ireland', scope: 'Public holidays (Organisation of Working Time Act 1997, Schedule 2)',
    sources: [
      'https://www.citizensinformation.ie/en/employment/employment-rights-and-conditions/leave-and-holidays/public-holidays/',
      'https://www.irishstatutebook.ie/eli/1997/act/20/schedule/2/enacted/en/html',
    ],
    notes: 'Irish law gives no automatic substitute weekday when a holiday falls on a weekend (employees get a day off within a month, an extra leave day or pay instead), so no observed dates are added. Good Friday is not a public holiday (listed as an observance).',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Lá Caille'),
      ...(y >= 2023 ? [H(weekday(dn(y, 2, 1)) === FRI ? dn(y, 2, 1) : nthWeekday(y, 2, MON, 1), "St Brigid's Day", 'Lá Fhéile Bríde')] : []),
      H(dn(y, 3, 17), "St Patrick's Day", 'Lá Fhéile Pádraig'),
      H(E(y, -2), 'Good Friday', 'Aoine an Chéasta', { type: 'observance' }),
      ...(y === 2022 ? [H(dn(2022, 3, 18), 'Public holiday (COVID-19 recognition)')] : []),
      H(E(y, 1), 'Easter Monday', 'Luan Cásca'),
      H(nthWeekday(y, 5, MON, 1), 'May Day', 'Lá Bealtaine'),
      H(nthWeekday(y, 6, MON, 1), 'June Bank Holiday', 'Lá Saoire i mí an Mheithimh'),
      H(nthWeekday(y, 8, MON, 1), 'August Bank Holiday', 'Lá Saoire i mí Lúnasa'),
      H(nthWeekday(y, 10, MON, -1), 'October Bank Holiday', 'Lá Saoire i mí Dheireadh Fómhair'),
      H(dn(y, 12, 25), 'Christmas Day', 'Lá Nollag'),
      H(dn(y, 12, 26), "St Stephen's Day", 'Lá Fhéile Stiofáin'),
    ],
  },

  DE: {
    name: 'Germany', scope: 'Gesetzliche Feiertage: nationwide plus per Bundesland',
    regions: {
      'DE-BW': 'Baden-Württemberg', 'DE-BY': 'Bayern', 'DE-BE': 'Berlin', 'DE-BB': 'Brandenburg', 'DE-HB': 'Bremen',
      'DE-HH': 'Hamburg', 'DE-HE': 'Hessen', 'DE-MV': 'Mecklenburg-Vorpommern', 'DE-NI': 'Niedersachsen',
      'DE-NW': 'Nordrhein-Westfalen', 'DE-RP': 'Rheinland-Pfalz', 'DE-SL': 'Saarland', 'DE-SN': 'Sachsen',
      'DE-ST': 'Sachsen-Anhalt', 'DE-SH': 'Schleswig-Holstein', 'DE-TH': 'Thüringen',
    },
    sources: [
      'https://www.bmi.bund.de/DE/themen/verfassung/staatliche-symbole/nationale-feiertage/nationale-feiertage-node.html',
      'https://www.revosax.sachsen.de/vorschrift/3997-SaechsSFG',
    ],
    notes: 'Holidays are set by each Land; without ?region= only the nine nationwide holidays (per BMI) are returned. Holidays that apply only in some municipalities (Fronleichnam in parts of Sachsen/Thüringen, Mariä Himmelfahrt in Catholic communities of Bayern, Augsburger Friedensfest) are not included. Easter Sunday and Whit Sunday are listed for Brandenburg (they fall on Sundays).',
    build: (y) => {
      const out = [
        H(dn(y, 1, 1), "New Year's Day", 'Neujahr'),
        H(dn(y, 1, 6), 'Epiphany', 'Heilige Drei Könige', { regions: ['DE-BW', 'DE-BY', 'DE-ST'] }),
        H(dn(y, 3, 8), "International Women's Day", 'Internationaler Frauentag', { regions: y >= 2023 ? ['DE-BE', 'DE-MV'] : ['DE-BE'] }),
        H(E(y, -2), 'Good Friday', 'Karfreitag'),
        H(E(y, 0), 'Easter Sunday', 'Ostersonntag', { regions: ['DE-BB'] }),
        H(E(y, 1), 'Easter Monday', 'Ostermontag'),
        H(dn(y, 5, 1), 'Labour Day', 'Tag der Arbeit'),
        H(E(y, 39), 'Ascension Day', 'Christi Himmelfahrt'),
        H(E(y, 49), 'Whit Sunday', 'Pfingstsonntag', { regions: ['DE-BB'] }),
        H(E(y, 50), 'Whit Monday', 'Pfingstmontag'),
        H(E(y, 60), 'Corpus Christi', 'Fronleichnam', { regions: ['DE-BW', 'DE-BY', 'DE-HE', 'DE-NW', 'DE-RP', 'DE-SL'] }),
        H(dn(y, 8, 15), 'Assumption Day', 'Mariä Himmelfahrt', { regions: ['DE-SL'] }),
        H(dn(y, 9, 20), "World Children's Day", 'Weltkindertag', { regions: ['DE-TH'] }),
        H(dn(y, 10, 3), 'Day of German Unity', 'Tag der Deutschen Einheit'),
        H(dn(y, 10, 31), 'Reformation Day', 'Reformationstag', { regions: ['DE-BB', 'DE-HB', 'DE-HH', 'DE-MV', 'DE-NI', 'DE-SN', 'DE-ST', 'DE-SH', 'DE-TH'] }),
        H(dn(y, 11, 1), "All Saints' Day", 'Allerheiligen', { regions: ['DE-BW', 'DE-BY', 'DE-NW', 'DE-RP', 'DE-SL'] }),
        H(onOrBefore(y, 11, 22, 3), 'Day of Repentance and Prayer', 'Buß- und Bettag', { regions: ['DE-SN'] }),
        H(dn(y, 12, 25), 'Christmas Day', '1. Weihnachtstag'),
        H(dn(y, 12, 26), 'Second Day of Christmas', '2. Weihnachtstag'),
      ];
      if (y === 2020) out.push(H(dn(2020, 5, 8), '75th anniversary of the end of WWII', 'Tag der Befreiung', { regions: ['DE-BE'] }));
      if (y === 2025) out.push(H(dn(2025, 5, 8), '80th anniversary of the end of WWII', 'Tag der Befreiung', { regions: ['DE-BE'] }));
      return out;
    },
  },

  FR: {
    name: 'France', scope: 'Jours fériés (Code du travail art. L3133-1), metropolitan France',
    sources: ['https://www.service-public.fr/particuliers/vosdroits/F2405', 'https://www.legifrance.gouv.fr/codes/article_lc/LEGIARTI000033008123'],
    notes: 'Alsace-Moselle (Good Friday, 26 December) and overseas departments are not included. Whit Monday is a legal holiday but is also the default "journée de solidarité", so many employers work it.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", "Jour de l'an"),
      H(E(y, 1), 'Easter Monday', 'Lundi de Pâques'),
      H(dn(y, 5, 1), 'Labour Day', 'Fête du Travail'),
      H(dn(y, 5, 8), 'Victory in Europe Day', 'Victoire 1945'),
      H(E(y, 39), 'Ascension Day', 'Ascension'),
      H(E(y, 50), 'Whit Monday', 'Lundi de Pentecôte'),
      H(dn(y, 7, 14), 'Bastille Day', 'Fête nationale'),
      H(dn(y, 8, 15), 'Assumption Day', 'Assomption'),
      H(dn(y, 11, 1), "All Saints' Day", 'Toussaint'),
      H(dn(y, 11, 11), 'Armistice Day', 'Armistice 1918'),
      H(dn(y, 12, 25), 'Christmas Day', 'Noël'),
    ],
  },

  IT: {
    name: 'Italy', scope: 'Festività nazionali (L. 260/1949 and amendments)',
    sources: [
      'https://www.normattiva.it/uri-res/N2Ls?urn:nir:stato:legge:1949-05-27;260',
      'https://www.normattiva.it/atto/caricaDettaglioAtto?atto.codiceRedazionale=25G00153&atto.dataPubblicazioneGazzetta=2025-10-10&tipoDettaglio=originario',
    ],
    notes: 'Local patron-saint days are not included. 4 October (San Francesco d’Assisi) is a national holiday from 2026 (Legge 8 ottobre 2025, n. 151).',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Capodanno'),
      H(dn(y, 1, 6), 'Epiphany', 'Epifania'),
      H(E(y, 0), 'Easter Sunday', 'Pasqua'),
      H(E(y, 1), 'Easter Monday', "Lunedì dell'Angelo"),
      H(dn(y, 4, 25), 'Liberation Day', 'Festa della Liberazione'),
      H(dn(y, 5, 1), 'Labour Day', 'Festa del Lavoro'),
      H(dn(y, 6, 2), 'Republic Day', 'Festa della Repubblica'),
      H(dn(y, 8, 15), 'Assumption Day', 'Ferragosto'),
      ...(y >= 2026 ? [H(dn(y, 10, 4), 'Saint Francis of Assisi', "San Francesco d'Assisi")] : []),
      H(dn(y, 11, 1), "All Saints' Day", 'Ognissanti'),
      H(dn(y, 12, 8), 'Immaculate Conception', 'Immacolata Concezione'),
      H(dn(y, 12, 25), 'Christmas Day', 'Natale'),
      H(dn(y, 12, 26), "St Stephen's Day", 'Santo Stefano'),
    ],
  },

  NL: {
    name: 'Netherlands', scope: 'Officiële feestdagen (Rijksoverheid)',
    sources: ['https://www.rijksoverheid.nl/onderwerpen/arbeidsovereenkomst-en-cao/vraag-en-antwoord/officiele-feestdagen'],
    notes: 'Dutch law gives no general right to a day off; Good Friday and Liberation Day are mostly working days, so they are listed as observances.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Nieuwjaarsdag'),
      H(E(y, -2), 'Good Friday', 'Goede Vrijdag', { type: 'observance' }),
      H(E(y, 0), 'Easter Sunday', 'Eerste Paasdag'),
      H(E(y, 1), 'Easter Monday', 'Tweede Paasdag'),
      H(weekday(dn(y, 4, 27)) === SUN ? dn(y, 4, 26) : dn(y, 4, 27), "King's Day", 'Koningsdag'),
      H(dn(y, 5, 5), 'Liberation Day', 'Bevrijdingsdag', { type: 'observance' }),
      H(E(y, 39), 'Ascension Day', 'Hemelvaartsdag'),
      H(E(y, 49), 'Whit Sunday', 'Eerste Pinksterdag'),
      H(E(y, 50), 'Whit Monday', 'Tweede Pinksterdag'),
      H(dn(y, 12, 25), 'Christmas Day', 'Eerste Kerstdag'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Tweede Kerstdag'),
    ],
  },

  BE: {
    name: 'Belgium', scope: 'Ten legal public holidays (FPS Employment)',
    sources: ['https://emploi.belgique.be/fr/themes/remuneration/jours-feries', 'https://werk.belgie.be/nl/themas/verloning/feestdagen'],
    notes: 'A holiday on a Sunday (or usual rest day) is replaced by a day chosen per company/sector, so no fixed observed dates are added.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Nieuwjaar / Jour de l’an'),
      H(E(y, 1), 'Easter Monday', 'Paasmaandag / Lundi de Pâques'),
      H(dn(y, 5, 1), 'Labour Day', 'Dag van de Arbeid / Fête du travail'),
      H(E(y, 39), 'Ascension Day', 'Onze-Lieve-Heer-Hemelvaart / Ascension'),
      H(E(y, 50), 'Whit Monday', 'Pinkstermaandag / Lundi de Pentecôte'),
      H(dn(y, 7, 21), 'National Day', 'Nationale feestdag / Fête nationale'),
      H(dn(y, 8, 15), 'Assumption Day', 'Onze-Lieve-Vrouw-Hemelvaart / Assomption'),
      H(dn(y, 11, 1), "All Saints' Day", 'Allerheiligen / Toussaint'),
      H(dn(y, 11, 11), 'Armistice Day', 'Wapenstilstand / Armistice'),
      H(dn(y, 12, 25), 'Christmas Day', 'Kerstmis / Noël'),
    ],
  },

  LU: {
    name: 'Luxembourg', scope: 'Jours fériés légaux (Code du travail L.232-2)',
    sources: ['https://guichet.public.lu/en/citoyens/travail-emploi/conges-jours-feries/jours-feries/jours-feries-legaux.html'],
    notes: 'A holiday on a Sunday gives employees a compensatory day within three months (not a fixed date), so no observed dates are added.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Neijoerschdag'),
      H(E(y, 1), 'Easter Monday', 'Ouschterméindeg'),
      H(dn(y, 5, 1), 'Labour Day', 'Dag vun der Aarbecht'),
      H(dn(y, 5, 9), 'Europe Day', 'Europadag'),
      H(E(y, 39), 'Ascension Day', 'Christi Himmelfaart'),
      H(E(y, 50), 'Whit Monday', 'Péngschtméindeg'),
      H(dn(y, 6, 23), 'National Day', 'Nationalfeierdag'),
      H(dn(y, 8, 15), 'Assumption Day', 'Léiffrawëschdag'),
      H(dn(y, 11, 1), "All Saints' Day", 'Allerhellgen'),
      H(dn(y, 12, 25), 'Christmas Day', 'Chrëschtdag'),
      H(dn(y, 12, 26), "St Stephen's Day", 'Stiefesdag'),
    ],
  },

  PT: {
    name: 'Portugal', scope: 'Feriados obrigatórios (Código do Trabalho art. 234)',
    sources: ['https://diariodarepublica.pt/dr/legislacao-consolidada/lei/2009-34546475-49255875', 'https://www.portugal.gov.pt/pt/gc24/area-de-governo/trabalho-solidariedade-e-seguranca-social'],
    notes: 'Carnival Tuesday is optional (listed as an observance). Municipal holidays are not included.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Ano Novo'),
      H(E(y, -47), 'Carnival', 'Carnaval', { type: 'observance' }),
      H(E(y, -2), 'Good Friday', 'Sexta-feira Santa'),
      H(E(y, 0), 'Easter Sunday', 'Páscoa'),
      H(dn(y, 4, 25), 'Freedom Day', 'Dia da Liberdade'),
      H(dn(y, 5, 1), 'Labour Day', 'Dia do Trabalhador'),
      H(E(y, 60), 'Corpus Christi', 'Corpo de Deus'),
      H(dn(y, 6, 10), 'Portugal Day', 'Dia de Portugal, de Camões e das Comunidades Portuguesas'),
      H(dn(y, 8, 15), 'Assumption Day', 'Assunção de Nossa Senhora'),
      H(dn(y, 10, 5), 'Republic Day', 'Implantação da República'),
      H(dn(y, 11, 1), "All Saints' Day", 'Dia de Todos-os-Santos'),
      H(dn(y, 12, 1), 'Restoration of Independence', 'Restauração da Independência'),
      H(dn(y, 12, 8), 'Immaculate Conception', 'Imaculada Conceição'),
      H(dn(y, 12, 25), 'Christmas Day', 'Natal'),
    ],
  },

  AT: {
    name: 'Austria', scope: 'Gesetzliche Feiertage (Arbeitsruhegesetz §7)',
    sources: ['https://www.usp.gv.at/mitarbeiter/arbeitszeit/woechentliche-ruhezeit-und-feiertagsruhe.html', 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008541'],
    notes: 'Good Friday has not been a holiday since 2019 (replaced by a personal day). 24 and 31 December are customary half days and are not included.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Neujahr'),
      H(dn(y, 1, 6), 'Epiphany', 'Heilige Drei Könige'),
      H(E(y, 1), 'Easter Monday', 'Ostermontag'),
      H(dn(y, 5, 1), 'National Holiday', 'Staatsfeiertag'),
      H(E(y, 39), 'Ascension Day', 'Christi Himmelfahrt'),
      H(E(y, 50), 'Whit Monday', 'Pfingstmontag'),
      H(E(y, 60), 'Corpus Christi', 'Fronleichnam'),
      H(dn(y, 8, 15), 'Assumption Day', 'Mariä Himmelfahrt'),
      H(dn(y, 10, 26), 'National Day', 'Nationalfeiertag'),
      H(dn(y, 11, 1), "All Saints' Day", 'Allerheiligen'),
      H(dn(y, 12, 8), 'Immaculate Conception', 'Mariä Empfängnis'),
      H(dn(y, 12, 25), 'Christmas Day', 'Christtag'),
      H(dn(y, 12, 26), "St Stephen's Day", 'Stefanitag'),
    ],
  },

  SE: {
    name: 'Sweden', scope: 'Allmänna helgdagar (Lag 1989:253) plus days treated as Sundays',
    sources: ['https://www.riksdagen.se/sv/dokument-och-lagar/dokument/svensk-forfattningssamling/lag-1989253-om-allmanna-helgdagar_sfs-1989-253/'],
    notes: 'Midsummer Eve, Christmas Eve and New Year’s Eve are not statutory holidays but are treated like Sundays (e.g. Semesterlagen) and banks are closed, so they are type "bank".',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Nyårsdagen'),
      H(dn(y, 1, 6), 'Epiphany', 'Trettondedag jul'),
      H(E(y, -2), 'Good Friday', 'Långfredagen'),
      H(E(y, 0), 'Easter Sunday', 'Påskdagen'),
      H(E(y, 1), 'Easter Monday', 'Annandag påsk'),
      H(dn(y, 5, 1), 'May Day', 'Första maj'),
      H(E(y, 39), 'Ascension Day', 'Kristi himmelsfärdsdag'),
      H(E(y, 49), 'Whit Sunday', 'Pingstdagen'),
      H(dn(y, 6, 6), 'National Day', 'Sveriges nationaldag'),
      H(onOrAfter(y, 6, 19, FRI), 'Midsummer Eve', 'Midsommarafton', { type: 'bank' }),
      H(onOrAfter(y, 6, 20, SAT), 'Midsummer Day', 'Midsommardagen'),
      H(onOrAfter(y, 10, 31, SAT), "All Saints' Day", 'Alla helgons dag'),
      H(dn(y, 12, 24), 'Christmas Eve', 'Julafton', { type: 'bank' }),
      H(dn(y, 12, 25), 'Christmas Day', 'Juldagen'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Annandag jul'),
      H(dn(y, 12, 31), "New Year's Eve", 'Nyårsafton', { type: 'bank' }),
    ],
  },

  NO: {
    name: 'Norway', scope: 'Helligdager (helligdagsfredloven) and 1 and 17 May',
    sources: ['https://lovdata.no/dokument/NL/lov/1995-02-24-12', 'https://lovdata.no/dokument/NL/lov/1947-04-26-1'],
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Første nyttårsdag'),
      H(E(y, -3), 'Maundy Thursday', 'Skjærtorsdag'),
      H(E(y, -2), 'Good Friday', 'Langfredag'),
      H(E(y, 0), 'Easter Sunday', 'Første påskedag'),
      H(E(y, 1), 'Easter Monday', 'Andre påskedag'),
      H(dn(y, 5, 1), 'Labour Day', 'Arbeidernes dag'),
      H(dn(y, 5, 17), 'Constitution Day', 'Grunnlovsdag'),
      H(E(y, 39), 'Ascension Day', 'Kristi himmelfartsdag'),
      H(E(y, 49), 'Whit Sunday', 'Første pinsedag'),
      H(E(y, 50), 'Whit Monday', 'Andre pinsedag'),
      H(dn(y, 12, 25), 'Christmas Day', 'Første juledag'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Andre juledag'),
    ],
  },

  DK: {
    name: 'Denmark', scope: 'Helligdage (folkekirkens helligdage; Store Bededag abolished from 2024)',
    sources: ['https://www.retsinformation.dk/eli/lta/2023/23', 'https://www.nationalbanken.dk/en/what-we-do/stable-prices-monetary-policy-and-the-danish-economy/bank-holidays'],
    notes: 'Constitution Day (5 June), Christmas Eve and New Year’s Eve are not public holidays by law; they are listed as observances.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Nytårsdag'),
      H(E(y, -3), 'Maundy Thursday', 'Skærtorsdag'),
      H(E(y, -2), 'Good Friday', 'Langfredag'),
      H(E(y, 0), 'Easter Sunday', 'Påskedag'),
      H(E(y, 1), 'Easter Monday', 'Anden påskedag'),
      ...(y <= 2023 ? [H(E(y, 26), 'General Prayer Day', 'Store bededag')] : []),
      H(E(y, 39), 'Ascension Day', 'Kristi himmelfartsdag'),
      H(E(y, 49), 'Whit Sunday', 'Pinsedag'),
      H(E(y, 50), 'Whit Monday', 'Anden pinsedag'),
      H(dn(y, 6, 5), 'Constitution Day', 'Grundlovsdag', { type: 'observance' }),
      H(dn(y, 12, 24), 'Christmas Eve', 'Juleaftensdag', { type: 'observance' }),
      H(dn(y, 12, 25), 'Christmas Day', 'Juledag'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Anden juledag'),
      H(dn(y, 12, 31), "New Year's Eve", 'Nytårsaftensdag', { type: 'observance' }),
    ],
  },

  FI: {
    name: 'Finland', scope: 'Public holidays (church holidays, May Day, Independence Day)',
    sources: ['https://www.finlex.fi/fi/lainsaadanto/2023/652', 'https://www.suomenpankki.fi/en/money-and-payments/bank-holidays/'],
    notes: 'Midsummer Eve and Christmas Eve are not statutory holidays but are general days off and bank closing days (type "bank").',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Uudenvuodenpäivä'),
      H(dn(y, 1, 6), 'Epiphany', 'Loppiainen'),
      H(E(y, -2), 'Good Friday', 'Pitkäperjantai'),
      H(E(y, 0), 'Easter Sunday', 'Pääsiäispäivä'),
      H(E(y, 1), 'Easter Monday', 'Toinen pääsiäispäivä'),
      H(dn(y, 5, 1), 'May Day', 'Vappu'),
      H(E(y, 39), 'Ascension Day', 'Helatorstai'),
      H(E(y, 49), 'Whit Sunday', 'Helluntaipäivä'),
      H(onOrAfter(y, 6, 19, FRI), 'Midsummer Eve', 'Juhannusaatto', { type: 'bank' }),
      H(onOrAfter(y, 6, 20, SAT), 'Midsummer Day', 'Juhannuspäivä'),
      H(onOrAfter(y, 10, 31, SAT), "All Saints' Day", 'Pyhäinpäivä'),
      H(dn(y, 12, 6), 'Independence Day', 'Itsenäisyyspäivä'),
      H(dn(y, 12, 24), 'Christmas Eve', 'Jouluaatto', { type: 'bank' }),
      H(dn(y, 12, 25), 'Christmas Day', 'Joulupäivä'),
      H(dn(y, 12, 26), "St Stephen's Day", 'Tapaninpäivä'),
    ],
  },

  PL: {
    name: 'Poland', scope: 'Dni wolne od pracy (Ustawa z 18 stycznia 1951 r.)',
    sources: ['https://isap.sejm.gov.pl/isap.nsf/DocDetails.xsp?id=WDU19510040028', 'https://eli.gov.pl/api/acts/DU/2024/1965/text.html'],
    notes: 'Christmas Eve (24 December) is a public holiday from 2025 (Dz.U. 2024 poz. 1965, in force 1 Feb 2025).',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Nowy Rok'),
      H(dn(y, 1, 6), 'Epiphany', 'Święto Trzech Króli'),
      H(E(y, 0), 'Easter Sunday', 'Wielkanoc'),
      H(E(y, 1), 'Easter Monday', 'Poniedziałek Wielkanocny'),
      H(dn(y, 5, 1), 'Labour Day', 'Święto Pracy'),
      H(dn(y, 5, 3), 'Constitution Day', 'Święto Konstytucji 3 Maja'),
      H(E(y, 49), 'Whit Sunday', 'Zielone Świątki'),
      H(E(y, 60), 'Corpus Christi', 'Boże Ciało'),
      H(dn(y, 8, 15), 'Assumption Day', 'Wniebowzięcie Najświętszej Maryi Panny'),
      H(dn(y, 11, 1), "All Saints' Day", 'Wszystkich Świętych'),
      H(dn(y, 11, 11), 'Independence Day', 'Narodowe Święto Niepodległości'),
      ...(y >= 2025 ? [H(dn(y, 12, 24), 'Christmas Eve', 'Wigilia Bożego Narodzenia')] : []),
      H(dn(y, 12, 25), 'Christmas Day', 'Boże Narodzenie (pierwszy dzień)'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Boże Narodzenie (drugi dzień)'),
    ],
  },

  CZ: {
    name: 'Czechia', scope: 'Státní svátky a ostatní svátky (zákon č. 245/2000 Sb.)',
    sources: ['https://www.psp.cz/sqw/sbirka.sqw?cz=245&r=2000', 'https://www.e-sbirka.cz/sb/2000/245'],
    build: (y) => [
      H(dn(y, 1, 1), 'Restoration Day of the Independent Czech State; New Year’s Day', 'Den obnovy samostatného českého státu; Nový rok'),
      H(E(y, -2), 'Good Friday', 'Velký pátek'),
      H(E(y, 1), 'Easter Monday', 'Velikonoční pondělí'),
      H(dn(y, 5, 1), 'Labour Day', 'Svátek práce'),
      H(dn(y, 5, 8), 'Liberation Day', 'Den vítězství'),
      H(dn(y, 7, 5), 'Saints Cyril and Methodius Day', 'Den slovanských věrozvěstů Cyrila a Metoděje'),
      H(dn(y, 7, 6), 'Jan Hus Day', 'Den upálení mistra Jana Husa'),
      H(dn(y, 9, 28), 'Czech Statehood Day', 'Den české státnosti'),
      H(dn(y, 10, 28), 'Independent Czechoslovak State Day', 'Den vzniku samostatného československého státu'),
      H(dn(y, 11, 17), 'Struggle for Freedom and Democracy Day', 'Den boje za svobodu a demokracii'),
      H(dn(y, 12, 24), 'Christmas Eve', 'Štědrý den'),
      H(dn(y, 12, 25), 'Christmas Day', '1. svátek vánoční'),
      H(dn(y, 12, 26), 'Second Day of Christmas', '2. svátek vánoční'),
    ],
  },

  HR: {
    name: 'Croatia', scope: 'Blagdani i neradni dani (Zakon o blagdanima, NN 110/19)',
    sources: ['https://narodne-novine.nn.hr/clanci/sluzbeni/2019_11_110_2147.html'],
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Nova godina'),
      H(dn(y, 1, 6), 'Epiphany', 'Bogojavljenje ili Sveta tri kralja'),
      H(E(y, 0), 'Easter Sunday', 'Uskrs'),
      H(E(y, 1), 'Easter Monday', 'Uskrsni ponedjeljak'),
      H(dn(y, 5, 1), 'Labour Day', 'Praznik rada'),
      H(dn(y, 5, 30), 'Statehood Day', 'Dan državnosti'),
      H(E(y, 60), 'Corpus Christi', 'Tijelovo'),
      H(dn(y, 6, 22), 'Anti-Fascist Struggle Day', 'Dan antifašističke borbe'),
      H(dn(y, 8, 5), 'Victory and Homeland Thanksgiving Day', 'Dan pobjede i domovinske zahvalnosti i Dan hrvatskih branitelja'),
      H(dn(y, 8, 15), 'Assumption Day', 'Velika Gospa'),
      H(dn(y, 11, 1), "All Saints' Day", 'Svi sveti'),
      H(dn(y, 11, 18), 'Remembrance Day', 'Dan sjećanja na žrtve Domovinskog rata'),
      H(dn(y, 12, 25), 'Christmas Day', 'Božić'),
      H(dn(y, 12, 26), "St Stephen's Day", 'Sveti Stjepan'),
    ],
  },

  SI: {
    name: 'Slovenia', scope: 'Prazniki in dela prosti dnevi (ZPDPD)',
    sources: [
      'https://pisrs.si/pregledPredpisa?id=ZAKO279',
      'https://www.gov.si/teme/drzavni-prazniki-in-dela-prosti-dnevi/',
      'https://pisrs.si/Pis.web/pregledPredpisa?id=ZAKO8865',
      'https://www.gov.si/novice/2023-08-11-pojasnila-z-delovnopravnega-vidika-glede-14-avgusta/',
    ],
    notes: 'Only work-free days are included (e.g. Reformation Day 31 Oct is work-free; Primož Trubar Day and other non-work-free holidays are omitted).',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Novo leto'),
      H(dn(y, 1, 2), "New Year's Day (second day)", 'Novo leto'),
      H(dn(y, 2, 8), 'Prešeren Day', 'Prešernov dan'),
      H(E(y, 0), 'Easter Sunday', 'Velikonočna nedelja'),
      H(E(y, 1), 'Easter Monday', 'Velikonočni ponedeljek'),
      H(dn(y, 4, 27), 'Day of Uprising Against Occupation', 'Dan upora proti okupatorju'),
      H(dn(y, 5, 1), 'Labour Day', 'Praznik dela'),
      H(dn(y, 5, 2), 'Labour Day (second day)', 'Praznik dela'),
      H(E(y, 49), 'Whit Sunday', 'Binkoštna nedelja'),
      H(dn(y, 6, 25), 'Statehood Day', 'Dan državnosti'),
      // ZOPNN-F art. 15 (Uradni list RS 88/2023): 14 August 2023 was a one-off work-free day after the floods.
      ...(y === 2023 ? [H(dn(2023, 8, 14), 'Solidarity Day', 'Dan solidarnosti')] : []),
      H(dn(y, 8, 15), 'Assumption Day', 'Marijino vnebovzetje'),
      H(dn(y, 10, 31), 'Reformation Day', 'Dan reformacije'),
      H(dn(y, 11, 1), 'Remembrance Day', 'Dan spomina na mrtve'),
      H(dn(y, 12, 25), 'Christmas Day', 'Božič'),
      H(dn(y, 12, 26), 'Independence and Unity Day', 'Dan samostojnosti in enotnosti'),
    ],
  },

  EE: {
    name: 'Estonia', scope: 'Riigipühad (Pühade ja tähtpäevade seadus)',
    sources: ['https://www.riigiteataja.ee/akt/PTS'],
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Uusaasta'),
      H(dn(y, 2, 24), 'Independence Day', 'Iseseisvuspäev'),
      H(E(y, -2), 'Good Friday', 'Suur reede'),
      H(E(y, 0), 'Easter Sunday', 'Ülestõusmispühade 1. püha'),
      H(dn(y, 5, 1), 'Spring Day', 'Kevadpüha'),
      H(E(y, 49), 'Whit Sunday', 'Nelipühade 1. püha'),
      H(dn(y, 6, 23), 'Victory Day', 'Võidupüha'),
      H(dn(y, 6, 24), 'Midsummer Day', 'Jaanipäev'),
      H(dn(y, 8, 20), 'Day of Restoration of Independence', 'Taasiseseisvumispäev'),
      H(dn(y, 12, 24), 'Christmas Eve', 'Jõululaupäev'),
      H(dn(y, 12, 25), 'Christmas Day', 'Esimene jõulupüha'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Teine jõulupüha'),
    ],
  },

  LT: {
    name: 'Lithuania', scope: 'Švenčių dienos (Darbo kodeksas, 123 str.)',
    sources: ['https://www.e-tar.lt/portal/lt/legalAct/f6d686707e7011e6b969d7ae07280e89/asr'],
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Naujieji metai'),
      H(dn(y, 2, 16), 'Day of Restoration of the State of Lithuania', 'Lietuvos valstybės atkūrimo diena'),
      H(dn(y, 3, 11), 'Day of Restoration of Independence', 'Lietuvos nepriklausomybės atkūrimo diena'),
      H(E(y, 0), 'Easter Sunday', 'Velykos'),
      H(E(y, 1), 'Easter Monday', 'Antroji Velykų diena'),
      H(dn(y, 5, 1), 'International Workers’ Day', 'Tarptautinė darbo diena'),
      H(nthWeekday(y, 5, SUN, 1), "Mother's Day", 'Motinos diena'),
      H(nthWeekday(y, 6, SUN, 1), "Father's Day", 'Tėvo diena'),
      H(dn(y, 6, 24), 'St John’s Day', 'Rasos ir Joninių diena'),
      H(dn(y, 7, 6), 'Statehood Day', 'Valstybės diena'),
      H(dn(y, 8, 15), 'Assumption Day', 'Žolinė'),
      H(dn(y, 11, 1), "All Saints' Day", 'Visų šventųjų diena'),
      H(dn(y, 11, 2), "All Souls' Day", 'Mirusiųjų atminimo diena'),
      H(dn(y, 12, 24), 'Christmas Eve', 'Kūčios'),
      H(dn(y, 12, 25), 'Christmas Day', 'Kalėdos'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Antroji Kalėdų diena'),
    ],
  },

  AU: {
    name: 'Australia', scope: 'National public holidays observed in every state and territory',
    sources: ['https://www.fairwork.gov.au/employment-conditions/public-holidays', 'https://www.nsw.gov.au/about-nsw/public-holidays', 'https://business.vic.gov.au/business-information/public-holidays'],
    notes: 'Only holidays common to all states and territories. State-only holidays (Easter Saturday, King’s Birthday, Labour Day, Melbourne Cup, etc.) are not included yet. Anzac Day has no national substitute (some states add one).',
    build: (y) => {
      const out = [
        H(dn(y, 1, 1), "New Year's Day", null, { sub: 'next' }),
        H(dn(y, 1, 26), 'Australia Day', null, { sub: 'next' }),
        H(E(y, -2), 'Good Friday'),
        H(E(y, 1), 'Easter Monday'),
        H(dn(y, 4, 25), 'Anzac Day'),
        H(dn(y, 12, 25), 'Christmas Day', null, { sub: 'next' }),
        H(dn(y, 12, 26), 'Boxing Day', null, { sub: 'next' }),
      ];
      if (y === 2022) out.push(H(dn(2022, 9, 22), 'National Day of Mourning for Queen Elizabeth II'));
      return out;
    },
  },

  NZ: {
    name: 'New Zealand', scope: 'National public holidays (Holidays Act 2003; Te Kāhui o Matariki Public Holiday Act 2022)',
    sources: ['https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-and-anniversary-dates/', 'https://www.legislation.govt.nz/act/public/2022/0014/latest/whole.html'],
    notes: 'Regional anniversary days are not included. Mondayisation applies to New Year, Waitangi, Anzac, Christmas and Boxing Day.',
    build: (y) => {
      const out = [
        H(dn(y, 1, 1), "New Year's Day", null, { sub: 'next' }),
        H(dn(y, 1, 2), "Day after New Year's Day", null, { sub: 'next' }),
        H(dn(y, 2, 6), 'Waitangi Day', null, { sub: 'next' }),
        H(E(y, -2), 'Good Friday'),
        H(E(y, 1), 'Easter Monday'),
        H(dn(y, 4, 25), 'Anzac Day', null, { sub: 'next' }),
        H(nthWeekday(y, 6, MON, 1), y >= 2023 ? "King's Birthday" : "Queen's Birthday"),
        H(nthWeekday(y, 10, MON, 4), 'Labour Day'),
        H(dn(y, 12, 25), 'Christmas Day', null, { sub: 'next' }),
        H(dn(y, 12, 26), 'Boxing Day', null, { sub: 'next' }),
      ];
      const m = MATARIKI[y];
      if (m) out.push(H(dn(y, m[0], m[1]), 'Matariki', 'Te Rā Aro ki a Matariki'));
      if (y === 2022) out.push(H(dn(2022, 9, 26), 'Queen Elizabeth II Memorial Day'));
      return out;
    },
  },

  JP: {
    name: 'Japan', scope: '国民の祝日 (Act on National Holidays) incl. substitute and citizens’ holidays',
    sources: ['https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html', 'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv'],
    notes: 'Equinox days are officially fixed each February for the following year; dates after the latest Cabinet Office announcement use the standard astronomical formula and could change. Bank holidays 2-3 January and 31 December are not included (banks close, but they are not national holidays).',
    custom: true,
    build: (y) => jpHolidays(y),
  },

  MX: {
    name: 'Mexico', scope: 'Días de descanso obligatorio (Ley Federal del Trabajo art. 74) plus CNBV bank holidays',
    sources: ['https://www.diputados.gob.mx/LeyesBiblio/pdf/LFT.pdf', 'https://sidof.segob.gob.mx/notas/docFuente/5775684'],
    notes: 'Holy Thursday, Good Friday, 2 November and 12 December are bank holidays set by the CNBV (type "bank"; 2026 list published in the DOF, later years assume the same pattern until published). Election-day rest days (always Sundays) are not included.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Año Nuevo'),
      H(nthWeekday(y, 2, MON, 1), 'Constitution Day', 'Día de la Constitución'),
      H(nthWeekday(y, 3, MON, 3), "Benito Juárez's Birthday", 'Natalicio de Benito Juárez'),
      H(E(y, -3), 'Holy Thursday', 'Jueves Santo', { type: 'bank' }),
      H(E(y, -2), 'Good Friday', 'Viernes Santo', { type: 'bank' }),
      H(dn(y, 5, 1), 'Labour Day', 'Día del Trabajo'),
      H(dn(y, 9, 16), 'Independence Day', 'Día de la Independencia'),
      ...((y - 2024) % 6 === 0 ? [H(dn(y, 10, 1), 'Presidential Inauguration', 'Transmisión del Poder Ejecutivo Federal')] : []),
      H(dn(y, 11, 2), "All Souls' Day", 'Día de Muertos', { type: 'bank' }),
      H(nthWeekday(y, 11, MON, 3), 'Revolution Day', 'Día de la Revolución'),
      H(dn(y, 12, 12), 'Day of the Virgin of Guadalupe', 'Día de la Virgen de Guadalupe', { type: 'bank' }),
      H(dn(y, 12, 25), 'Christmas Day', 'Navidad'),
    ],
  },

  BR: {
    name: 'Brazil', scope: 'Feriados nacionais (Lei 662/1949 and amendments) plus bank holidays',
    sources: ['https://www.planalto.gov.br/ccivil_03/leis/l0662.htm', 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/lei/l14759.htm', 'https://www.gov.br/gestao/pt-br'],
    notes: 'Carnival Monday/Tuesday and Corpus Christi are "pontos facultativos" (optional for the federal government) but banks are closed, so they are type "bank". State and municipal holidays are not included. Black Consciousness Day (20 Nov) is national from 2024.',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Confraternização Universal'),
      H(E(y, -48), 'Carnival Monday', 'Carnaval', { type: 'bank' }),
      H(E(y, -47), 'Carnival Tuesday', 'Carnaval', { type: 'bank' }),
      H(E(y, -2), 'Good Friday', 'Paixão de Cristo'),
      H(dn(y, 4, 21), 'Tiradentes Day', 'Tiradentes'),
      H(dn(y, 5, 1), 'Labour Day', 'Dia do Trabalho'),
      H(E(y, 60), 'Corpus Christi', 'Corpus Christi', { type: 'bank' }),
      H(dn(y, 9, 7), 'Independence Day', 'Independência do Brasil'),
      H(dn(y, 10, 12), 'Our Lady of Aparecida', 'Nossa Senhora Aparecida'),
      H(dn(y, 11, 2), "All Souls' Day", 'Finados'),
      H(dn(y, 11, 15), 'Republic Proclamation Day', 'Proclamação da República'),
      ...(y >= 2024 ? [H(dn(y, 11, 20), 'Black Consciousness Day', 'Dia Nacional de Zumbi e da Consciência Negra')] : []),
      H(dn(y, 12, 25), 'Christmas Day', 'Natal'),
    ],
  },

  IS: {
    name: 'Iceland', scope: 'Frídagar (Lög nr. 88/1971, 6. gr.)',
    sources: ['https://www.althingi.is/lagas/nuna/1971088.html'],
    notes: 'Christmas Eve and New Year’s Eve are holidays from 13:00 only, so they are listed as observances (business days).',
    build: (y) => [
      H(dn(y, 1, 1), "New Year's Day", 'Nýársdagur'),
      H(E(y, -3), 'Maundy Thursday', 'Skírdagur'),
      H(E(y, -2), 'Good Friday', 'Föstudagurinn langi'),
      H(E(y, 0), 'Easter Sunday', 'Páskadagur'),
      H(E(y, 1), 'Easter Monday', 'Annar í páskum'),
      H(onOrAfter(y, 4, 19, THU), 'First Day of Summer', 'Sumardagurinn fyrsti'),
      H(dn(y, 5, 1), 'Labour Day', 'Verkalýðsdagurinn'),
      H(E(y, 39), 'Ascension Day', 'Uppstigningardagur'),
      H(E(y, 49), 'Whit Sunday', 'Hvítasunnudagur'),
      H(E(y, 50), 'Whit Monday', 'Annar í hvítasunnu'),
      H(dn(y, 6, 17), 'National Day', 'Þjóðhátíðardagurinn'),
      H(nthWeekday(y, 8, MON, 1), 'Commerce Day', 'Frídagur verslunarmanna'),
      H(dn(y, 12, 24), 'Christmas Eve (from 13:00)', 'Aðfangadagur jóla', { type: 'observance' }),
      H(dn(y, 12, 25), 'Christmas Day', 'Jóladagur'),
      H(dn(y, 12, 26), 'Second Day of Christmas', 'Annar í jólum'),
      H(dn(y, 12, 31), "New Year's Eve (from 13:00)", 'Gamlársdagur', { type: 'observance' }),
    ],
  },

  ZA: {
    name: 'South Africa', scope: 'Public holidays (Public Holidays Act 36 of 1994)',
    sources: [
      'https://www.gov.za/about-sa/public-holidays',
      'https://www.gov.za/documents/public-holidays-act',
      'https://www.gov.za/documents/notices/public-holidays-act-declaration-fourth-day-november-2026-public-holiday',
      'https://www.presidency.gov.za/president-ramaphosa-declares-election-day-4-november-2026-public-holiday',
    ],
    notes: 'A holiday on a Sunday moves to the Monday (Public Holidays Act s.2(1)). When that Monday is already a holiday (Christmas on a Sunday), the Act gives no further day; the President proclaimed Tuesday 27 December in 2011, 2016 and 2022, and later cases (2033-12-27) are listed as predicted until proclaimed. One-off holidays declared under s.2A (election days, 15 Dec 2023, 4 Nov 2026 local government elections, Proclamation 346 of 2026) are included; future ones are added when proclaimed.',
    // Chained substitutes (observed 2+ days after the holiday) are not in the Act; only the proclaimed ones are firm.
    post: (entries) => {
      const proclaimed = new Set([dn(2022, 12, 27)]);
      for (const h of entries) {
        if (h.observed != null && h.observed - h.n >= 2 && !proclaimed.has(h.observed)) {
          h.predicted = true;
          h.note = 'Predicted: the Act moves a Sunday holiday to Monday only; a Tuesday has been proclaimed in past years (2011, 2016, 2022) but not yet for this year.';
        }
      }
      return entries;
    },
    build: (y) => {
      const out = [
        H(dn(y, 1, 1), "New Year's Day", null, { sub: 'next_sun' }),
        H(dn(y, 3, 21), 'Human Rights Day', null, { sub: 'next_sun' }),
        H(E(y, -2), 'Good Friday'),
        H(E(y, 1), 'Family Day'),
        H(dn(y, 4, 27), 'Freedom Day', null, { sub: 'next_sun' }),
        H(dn(y, 5, 1), "Workers' Day", null, { sub: 'next_sun' }),
        H(dn(y, 6, 16), 'Youth Day', null, { sub: 'next_sun' }),
        H(dn(y, 8, 9), "National Women's Day", null, { sub: 'next_sun' }),
        H(dn(y, 9, 24), 'Heritage Day', null, { sub: 'next_sun' }),
        H(dn(y, 12, 16), 'Day of Reconciliation', null, { sub: 'next_sun' }),
        H(dn(y, 12, 25), 'Christmas Day', null, { sub: 'next_sun' }),
        H(dn(y, 12, 26), 'Day of Goodwill', null, { sub: 'next_sun' }),
      ];
      if (y === 2021) out.push(H(dn(2021, 11, 1), 'Local Government Elections'));
      if (y === 2023) out.push(H(dn(2023, 12, 15), 'Rugby World Cup victory public holiday'));
      if (y === 2024) out.push(H(dn(2024, 5, 29), 'National and Provincial Elections'));
      // Proclamation Notice 346 of 2026, Government Gazette 55352 (8 Sep 2026), Public Holidays Act s.2A.
      if (y === 2026) out.push(H(dn(2026, 11, 4), 'Local Government Elections'));
      return out;
    },
  },
};

// Matariki public holiday dates, Te Kāhui o Matariki Public Holiday Act 2022, Schedule 1 (2022-2052 excerpt).
const MATARIKI = {
  2022: [6, 24], 2023: [7, 14], 2024: [6, 28], 2025: [6, 20], 2026: [7, 10], 2027: [6, 25], 2028: [7, 14],
  2029: [7, 6], 2030: [6, 21], 2031: [7, 11], 2032: [7, 2], 2033: [6, 24], 2034: [7, 7], 2035: [6, 29],
};

// ---------------- Japan ----------------
const vernal = (y) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnal = (y) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

function jpHolidays(y) {
  const base = [
    H(dn(y, 1, 1), "New Year's Day", '元日'),
    H(nthWeekday(y, 1, MON, 2), 'Coming of Age Day', '成人の日'),
    H(dn(y, 2, 11), 'National Foundation Day', '建国記念の日'),
    ...(y >= 2020 ? [H(dn(y, 2, 23), "The Emperor's Birthday", '天皇誕生日')] : []),
    H(dn(y, 3, vernal(y)), 'Vernal Equinox Day', '春分の日'),
    H(dn(y, 4, 29), 'Showa Day', '昭和の日'),
    H(dn(y, 5, 3), 'Constitution Memorial Day', '憲法記念日'),
    H(dn(y, 5, 4), 'Greenery Day', 'みどりの日'),
    H(dn(y, 5, 5), "Children's Day", 'こどもの日'),
    H(y === 2020 ? dn(2020, 7, 23) : y === 2021 ? dn(2021, 7, 22) : nthWeekday(y, 7, MON, 3), 'Marine Day', '海の日'),
    H(y === 2020 ? dn(2020, 8, 10) : y === 2021 ? dn(2021, 8, 8) : dn(y, 8, 11), 'Mountain Day', '山の日'),
    H(nthWeekday(y, 9, MON, 3), 'Respect for the Aged Day', '敬老の日'),
    H(dn(y, 9, autumnal(y)), 'Autumnal Equinox Day', '秋分の日'),
    H(y === 2020 ? dn(2020, 7, 24) : y === 2021 ? dn(2021, 7, 23) : nthWeekday(y, 10, MON, 2), 'Sports Day', 'スポーツの日'),
    H(dn(y, 11, 3), 'Culture Day', '文化の日'),
    H(dn(y, 11, 23), 'Labour Thanksgiving Day', '勤労感謝の日'),
  ];
  const days = new Set(base.map((h) => h.n));
  const out = [...base];
  // Citizens' holiday (国民の休日): a non-Sunday day sandwiched between two national holidays.
  for (const h of base) {
    const mid = h.n + 1;
    if (!days.has(mid) && days.has(h.n + 2) && weekday(mid) !== SUN) {
      out.push(H(mid, "Citizens' Holiday", '国民の休日'));
      days.add(mid);
    }
  }
  // Substitute holiday (振替休日): a holiday on Sunday -> the nearest following day that is not a holiday.
  for (const h of base) {
    if (weekday(h.n) !== SUN) continue;
    let d = h.n + 1;
    while (days.has(d)) d++;
    out.push(H(d, 'Substitute Holiday', '振替休日'));
    days.add(d);
  }
  return out.sort((a, b) => a.n - b.n);
}

export const COUNTRY_CODES = Object.keys(COUNTRIES).sort();
