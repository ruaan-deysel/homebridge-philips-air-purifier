/**
 * Device status keys, ported from PhilipsApi in the HA integration's const.py
 * (github.com/ruaan-deysel/ha-philips-airpurifier).
 *
 * Keys are grouped by API generation. Gen1 uses readable names, gen2 and gen3
 * use opaque D-codes. Some registry entries carry a `#N` variant suffix — see
 * deviceKey() in models.ts.
 *
 * Four facts below are hardware-verified on real AC4220/12 firmware and
 * CONTRADICT the reference registry. The hardware wins; do not "correct"
 * these back to match the Python source.
 *
 *   1. D03105 (DISPLAY_BACKLIGHT) is READ-ONLY: writes are ACKed and silently
 *      discarded, and it reads 101 when the lamp is on. The HA registry maps
 *      it as the light entity for AC4220-family models — that would be a
 *      dead control. The real writable light control is D03135 (LAMP_MODE),
 *      domain {0, 1, 2}.
 *   2. D03130 (BEEP) is boolean but stored as 0 / 100, not 0 / 1. Writing 1
 *      reads back 100.
 *   3. D0310C = 5 (MODE_B) reports fan speed 18, i.e. speed 5 IS Turbo. So
 *      turbo (18) and medium (19) must not appear alongside speed 5 in the
 *      AC4220/AC32xx preset list — they would duplicate speed 5 and speed 3.
 *   4. D03137 (AMBIENT_LIGHT_MODE) is NOT writable: writing 0 reads back 1.
 */

/** Gen1 keys: readable field names, used by the oldest devices. */
export const Gen1Key = {
  AIR_QUALITY_INDEX: 'aqit',
  CHILD_LOCK: 'cl',
  DEVICE_ID: 'DeviceId',
  DEVICE_VERSION: 'DeviceVersion',
  DISPLAY_BACKLIGHT: 'uil',
  ERROR_CODE: 'err',
  FILTER_PREFIX: 'flt',
  FILTER_WICK_PREFIX: 'wick',
  FILTER_STATUS: 'sts',
  FILTER_TOTAL: 'total',
  FILTER_TYPE: 't',
  FILTER_PRE: 'fltsts0',
  FILTER_PRE_TOTAL: 'flttotal0',
  FILTER_PRE_TYPE: 'fltt0',
  FILTER_HEPA: 'fltsts1',
  FILTER_HEPA_TOTAL: 'flttotal1',
  FILTER_HEPA_TYPE: 'fltt1',
  FILTER_ACTIVE_CARBON: 'fltsts2',
  FILTER_ACTIVE_CARBON_TOTAL: 'flttotal2',
  FILTER_ACTIVE_CARBON_TYPE: 'fltt2',
  FILTER_WICK: 'wicksts',
  FILTER_WICK_TOTAL: 'wicktotal',
  FILTER_WICK_TYPE: 'wickt',
  FILTER_NANOPROTECT_PREFILTER: 'D05-13',
  FILTER_NANOPROTECT_CLEAN_TOTAL: 'D05-07',
  FILTER_NANOPROTECT: 'D05-14',
  FILTER_NANOPROTECT_TOTAL: 'D05-08',
  FILTER_NANOPROTECT_TYPE: 'D05-02',
  FUNCTION: 'func',
  HUMIDITY: 'rh',
  HUMIDITY_TARGET: 'rhset',
  INDOOR_ALLERGEN_INDEX: 'iaql',
  LANGUAGE: 'language',
  LIGHT_BRIGHTNESS: 'aqil',
  MODE: 'mode',
  MODEL_ID: 'modelid',
  NAME: 'name',
  PM25: 'pm25',
  POWER: 'pwr',
  // Unfortunately, the preferred index key for the index with and without gas
  // are the same in the source API. To distinguish, # is used as a separator.
  PREFERRED_INDEX: 'ddp#1',
  GAS_PREFERRED_INDEX: 'ddp#2',
  PRODUCT_ID: 'ProductId',
  RUNTIME: 'Runtime',
  SOFTWARE_VERSION: 'swversion',
  SPEED: 'om',
  TEMPERATURE: 'temp',
  TOTAL_VOLATILE_ORGANIC_COMPOUNDS: 'tvoc',
  TYPE: 'type',
  WATER_LEVEL: 'wl',
  WIFI_VERSION: 'WifiVersion',
  RSSI: 'rssi',
  /** Sound/beep control for older gen1 models (e.g. AC2729). Same value as DISPLAY_BACKLIGHT. */
  BEEP: 'uil',
} as const

/** Gen2 keys: the "D0N-NN" scheme (source calls these NEW_*), e.g. AC1715. */
export const Gen2Key = {
  NAME: 'D01-03',
  MODEL_ID: 'D01-05',
  LANGUAGE: 'D01-07',
  SOFTWARE_VERSION: 'D01-21',
  POWER: 'D03-02',
  DISPLAY_BACKLIGHT: 'D03-05',
  MODE: 'D03-12',
  INDOOR_ALLERGEN_INDEX: 'D03-32',
  PM25: 'D03-33',
  PREFERRED_INDEX: 'D03-42',
} as const

/**
 * Gen3 keys: the "D0NSNN" / "D0NNNN" scheme (source calls these NEW2_*), used
 * by the newest devices including the hardware-verified AC4220/12.
 */
export const Gen3Key = {
  NAME: 'D01S03',
  MODEL_ID: 'D01S05',
  SERIAL: 'D01S0D',
  SOFTWARE_VERSION: 'D01S12',
  POWER: 'D03102',
  CHILD_LOCK: 'D03103',
  /**
   * Display backlight. READ-ONLY on AC4220/12 firmware: writes are ACKed and
   * ignored, and it reads 101 when the lamp is on. Use LAMP_MODE to control it.
   */
  DISPLAY_BACKLIGHT: 'D03105',
  /**
   * Display-backlight key used by AMF765/AMF870 (source: NEW2_DISPLAY_BACKLIGHT,
   * upstream's primary variant). DISPLAY_BACKLIGHT above (D03105) is upstream's
   * NEW2_DISPLAY_BACKLIGHT2 — a different key, not a fallback for this one.
   */
  DISPLAY_BACKLIGHT_PRIMARY: 'D0312D',
  MODE_A: 'D0310A',
  /** Mode and speed selector: 0 auto, 1-5 speeds (5 == turbo), 17 sleep, 18 turbo, 19 medium. */
  MODE_B: 'D0310C',
  /** Reported fan speed. Read-only. Source also calls this NEW2_MODE_C in some model configs. */
  FAN_SPEED: 'D0310D',
  MODE_C: 'D0310D',
  TIMER: 'D03110',
  INDOOR_ALLERGEN_INDEX: 'D03120',
  PM25: 'D03221',
  GAS: 'D03122',
  HUMIDITY: 'D03125',
  TEMPERATURE: 'D03224',
  TARGET_TEMP: 'D0310E',
  PREFERRED_INDEX: 'D0312A',
  /** Beep. Boolean, but stored as 0/100 — writing 1 reads back 100. */
  BEEP: 'D03130',
  STANDBY_SENSORS: 'D03134',
  /** CX7550: show temperature in standby. */
  STANDBY_TEMP_DISPLAY: 'D03133',
  /** Lamp mode: 0 off, 1 on, 2 on (dim). 3 clamps to 2. The real light control. */
  LAMP_MODE: 'D03135',
  /** Ambient light mode. NOT writable on AC4220/12 — reads back 1 regardless. */
  AMBIENT_LIGHT_MODE: 'D03137',
  AUTO_QUICKDRY_MODE: 'D03138',
  QUICKDRY_MODE: 'D03139',
  ERROR_CODE: 'D03240',
  AUTO_PLUS_AI: 'D03180',
  OSCILLATION: 'D0320F',
  FILTER_PREFILTER: 'D0520D',
  FILTER_PREFILTER_TOTAL: 'D05207',
  FILTER_NANOPROTECT: 'D0540E',
  FILTER_NANOPROTECT_TOTAL: 'D05408',
} as const
