const DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH = 240;
const MEDIUM_MINIMAL_RESIZE_RUNWAY = 8;
const MEDIUM_MINIMAL_TRANSITION_MIN_WIDTH =
  DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH -
  MEDIUM_MINIMAL_RESIZE_RUNWAY;

function getMediumMinimalWidthConstraint(availableWidth) {
  const numeric = Number(availableWidth);
  const normalizedAvailableWidth = Number.isFinite(numeric)
    ? Math.max(1, Math.round(numeric))
    : DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH;
  const width = Math.min(
    normalizedAvailableWidth,
    DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH,
  );
  return {
    width,
    minWidth: Math.min(
      width,
      MEDIUM_MINIMAL_TRANSITION_MIN_WIDTH,
    ),
  };
}

module.exports = {
  DEFAULT_MEDIUM_MINIMAL_WINDOW_WIDTH,
  MEDIUM_MINIMAL_RESIZE_RUNWAY,
  MEDIUM_MINIMAL_TRANSITION_MIN_WIDTH,
  getMediumMinimalWidthConstraint,
};
