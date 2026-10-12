import { createWheelStepper, WHEEL_NAVIGATION } from "@panelyth/ui"

/**
 * The wheel as "next file / previous file" (Stage P04). One stepper for the
 * window: the picture under the pointer is replaced at every step and takes
 * its wheel handler with it, while the stream of events of one swipe goes
 * on, so the travel and the time of the last step cannot live in the
 * picture's component.
 */
export const wheelNavigationStep = createWheelStepper(WHEEL_NAVIGATION)
