import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPdfText } from '../src/services/pdf-text.js';
import { parseNetlinePdf } from '../src/services/pdf-roster-parser.js';

// Made-up legs in the column layout of the real export (the real files are personal data and stay out of git).
async function parseCsv(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-table-test-'));
  const file = path.join(dir, 'legs.csv');
  try {
    fs.writeFileSync(file, lines.map(l => l.join(',')).join('\n'));
    return parseNetlinePdf(await readPdfText(file));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('crew legs export: Flt_Nbr/airports/AC type, local times (actual "A", else scheduled "E"), C/I and C/O per duty period, pairing/block/layover in info', async () => {
  const header = ['EMPL_NBR', 'Rotn_Beg_Dt', 'Rotn_Prng_Nbr', 'Duty_Perd_Id', 'Flt_Orig_Dt', 'Flt_Nbr', 'Dprt_Arpt_Cd', 'Arr_Arpt_Cd', 'Actl_Crew_Schlg_Ac_Typ_Cd',
    'schld_dprt_lcl_dttm', 'schld_arr_lcl_dttm', 'schld_dprt_gmt_dttm', 'schld_arr_gmt_dttm',
    'actl_dprt_lcl_dttm', 'actl_arr_lcl_dttm', 'actl_dprt_gmt_dttm', 'actl_arr_gmt_dttm', 'Actl_Duty_Rpt_Lcl_Dttm', 'Actl_Duty_Rls_Lcl_Dttm',
    'Schld_Leg_Blk_Tm_Mnt_Cnt', 'Actl_Leg_Blk_Tm_Mnt_Cnt', 'Duty_Layovr_Tm_Mnt_Cnt'];
  const leg = (rot, dp, date, flt, dep, arr, sd, sa, ad, aa, rpt, rls, blk = ['', ''], lay = '0') => ['000000001', rot, '0100', dp, date, flt, `${dep}  `, `${arr}  `, '717',
    sd, sa, sd.replace(/ \d\d/, ' 00'), sa.replace(/ \d\d/, ' 00'), ad, aa, ad && ad.replace(/ \d\d/, ' 00'), aa && aa.replace(/ \d\d/, ' 00'), rpt, rls, ...blk, lay];
  const r = await parseCsv([header,
    leg('2026-03-02', '1', '2026-03-02', '1001', 'AAA', 'BBB', '2026-03-02 09:00:00', '2026-03-02 10:30:00', '2026-03-02 08:55:00', '2026-03-02 10:18:00', '2026-03-02 08:00:00', '2026-03-02 13:14:00', ['90', '84'], '1251'),
    leg('2026-03-02', '1', '2026-03-02', '1002', 'BBB', 'AAA', '2026-03-02 11:20:00', '2026-03-02 13:00:00', '2026-03-02 11:17:00', '2026-03-02 12:44:00', '2026-03-02 08:00:00', '2026-03-02 13:14:00', ['100', '87'], '1251'),
    // the next duty period: no actual times yet, released after midnight
    leg('2026-03-02', '2', '2026-03-03', '1003', 'AAA', 'CCC', '2026-03-03 22:10:00', '2026-03-03 23:40:00', '', '', '2026-03-03 21:10:00', '2026-03-04 00:10:00', ['90', ' ']),
  ]);
  assert.equal(r.format, 'table-crew-legs');
  assert.deepEqual(r.published.map(x => [x.date, x.day, x.duty, x.dep, x.begin, x.end, x.arr, x.ac, x.info]), [
    ['2 Mar 26', 'Mon', 'C/I', '', '08:00 L', '', '', '', ''],
    ['2 Mar 26', 'Mon', '1001', 'AAA', 'A08:55 L', 'A10:18 L', 'BBB', '717', '[Pairing: 0100] [Block: 01:24]'],
    ['2 Mar 26', 'Mon', '1002', 'BBB', 'A11:17 L', 'A12:44 L', 'AAA', '717', '[Pairing: 0100] [Block: 01:27]'],
    ['2 Mar 26', 'Mon', 'C/O', '', '', '13:14 L', '', '', '[Pairing: 0100] [Layover: 20:51]'],
    ['3 Mar 26', 'Tue', 'C/I', '', '21:10 L', '', '', '', ''],
    ['3 Mar 26', 'Tue', '1003', 'AAA', 'E22:10 L', 'E23:40 L', 'CCC', '717', '[Pairing: 0100] [Block: 01:30]'],
    ['3 Mar 26', 'Tue', 'C/O', '', '', '00:10 L +1', '', '', '[Pairing: 0100]'],
  ]);
});
