import { describe, expect, it } from 'vitest';
import { DEMO_OTHER_USER_EMAIL, demoSeedStatements } from './db';

describe('demoSeedStatements', () => {
  it('seeds nothing when no env is set', () => {
    expect(demoSeedStatements({})).toEqual([]);
  });

  it('seeds only the staff row when SEED_STAFF_EMAIL is set', () => {
    const stmts = demoSeedStatements({ SEED_STAFF_EMAIL: 'sa@example.com' });
    expect(stmts).toHaveLength(1);
    expect(stmts[0].text).toContain('cofee_shop.staff');
    expect(stmts[0].values).toEqual(['sa@example.com', 'sa']);
    // emails are bind params, never interpolated into SQL text
    expect(stmts[0].text).not.toContain('sa@example.com');
  });

  it('ignores a blank SEED_STAFF_EMAIL', () => {
    expect(demoSeedStatements({ SEED_STAFF_EMAIL: '  ' })).toEqual([]);
  });

  it('seeds preferences, memories and the RLS demo order when opted in', () => {
    const stmts = demoSeedStatements({
      SEED_STAFF_EMAIL: 'sa@example.com',
      SEED_DEMO_PREFERENCES: 'true',
    });
    expect(stmts).toHaveLength(5);
    expect(stmts[1].text).toContain('cofee_shop.customer_preferences');
    expect(stmts[2].text).toContain('cofee_shop.user_memories');
    expect(stmts[3].text).toContain('cofee_shop.orders');
    expect(stmts[4].text).toContain('cofee_shop.order_items');
    // the "other customer" order belongs to the fictional demo user, not the deployer
    expect(stmts[3].values).toContain(DEMO_OTHER_USER_EMAIL);
    expect(stmts[4].values).toContain(DEMO_OTHER_USER_EMAIL);
    for (const s of stmts) expect(s.text).not.toContain('sa@example.com');
  });

  it('seeds the RLS demo order even without a staff email', () => {
    const stmts = demoSeedStatements({ SEED_DEMO_PREFERENCES: '1' });
    expect(stmts).toHaveLength(2);
    expect(stmts[0].text).toContain('cofee_shop.orders');
    expect(stmts[1].text).toContain('cofee_shop.order_items');
  });

  it.each(['false', '0', 'no', 'off', ''])('does not seed demo data for flag "%s"', (flag) => {
    const stmts = demoSeedStatements({ SEED_STAFF_EMAIL: 'sa@example.com', SEED_DEMO_PREFERENCES: flag });
    expect(stmts).toHaveLength(1);
    expect(stmts[0].text).toContain('cofee_shop.staff');
  });
});
