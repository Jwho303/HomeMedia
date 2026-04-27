import { describe, it, expect, beforeEach } from 'vitest';
import { setCachedEncodersForTests, getCachedEncoders } from '../src/encoders.js';

describe('encoders detection cache', () => {
  beforeEach(() => {
    setCachedEncodersForTests(null);
  });

  it('starts with no cached value', () => {
    expect(getCachedEncoders()).toBeNull();
  });

  it('setCachedEncodersForTests round-trips', () => {
    setCachedEncodersForTests({ nvenc: true, qsv: false, videotoolbox: false });
    expect(getCachedEncoders()).toEqual({ nvenc: true, qsv: false, videotoolbox: false });
  });
});
