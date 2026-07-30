export type MinimalOrientation = "horizontal" | "medium" | "vertical";

export const AUTO_MINIMAL_EXIT_HYSTERESIS = 20;
export const VERTICAL_MINIMAL_ENTER_WIDTH = 240;

export function chooseMinimalOrientationForSize(
  size: { width: number; height: number },
  widthThreshold: number,
  _heightThreshold: number,
): MinimalOrientation {
  if (size.width > 0 && size.width < VERTICAL_MINIMAL_ENTER_WIDTH) {
    return "vertical";
  }
  if (size.width > 0 && size.width <= widthThreshold) {
    return "medium";
  }
  return "horizontal";
}

export function chooseActiveMinimalOrientationForSize(
  size: { width: number; height: number },
  widthThreshold: number,
  _heightThreshold: number,
  currentOrientation: MinimalOrientation,
): MinimalOrientation {
  const holdVerticalUntil =
    VERTICAL_MINIMAL_ENTER_WIDTH + AUTO_MINIMAL_EXIT_HYSTERESIS;
  if (size.width < VERTICAL_MINIMAL_ENTER_WIDTH) {
    return "vertical";
  }

  if (
    currentOrientation === "vertical" &&
    size.width <= holdVerticalUntil
  ) {
    return "vertical";
  }

  const releaseMediumAt =
    widthThreshold + AUTO_MINIMAL_EXIT_HYSTERESIS;
  if (size.width <= widthThreshold) return "medium";
  if (
    currentOrientation === "medium" &&
    size.width <= releaseMediumAt
  ) {
    return "medium";
  }

  return "horizontal";
}

export function shouldExitMinimalForSize(
  size: { width: number; height: number },
  widthThreshold: number,
  heightThreshold: number,
) {
  return (
    size.width > widthThreshold + AUTO_MINIMAL_EXIT_HYSTERESIS &&
    size.height > heightThreshold + AUTO_MINIMAL_EXIT_HYSTERESIS
  );
}
