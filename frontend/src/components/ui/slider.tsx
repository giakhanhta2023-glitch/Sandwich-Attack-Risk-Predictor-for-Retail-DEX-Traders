"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { Slider as SliderPrimitive } from "radix-ui"

/**
 * The visible track is a 1px hairline, but the hit area must not be.
 *
 * Radix positions the thumb absolutely, so it contributes nothing to the
 * root's height: with a 1px track the whole slider collapsed to a 1px strip
 * and could not be dragged. The root now carries a 20px hit area with the
 * hairline centred inside it, and the 3px thumb gets an invisible 23x26 grab
 * target via a pseudo-element.
 */
function Slider({
  className,
  defaultValue,
  value,
  min = 0,
  max = 100,
  ...props
}: React.ComponentProps<typeof SliderPrimitive.Root>) {
  const _values = React.useMemo(
    () =>
      Array.isArray(value)
        ? value
        : Array.isArray(defaultValue)
          ? defaultValue
          : [min, max],
    [value, defaultValue, min, max]
  )

  return (
    <SliderPrimitive.Root
      data-slot="slider"
      defaultValue={defaultValue}
      value={value}
      min={min}
      max={max}
      className={cn(
        "relative flex w-full cursor-pointer touch-none items-center select-none data-[orientation=horizontal]:h-5 data-[disabled]:opacity-50 data-[orientation=vertical]:h-full data-[orientation=vertical]:min-h-44 data-[orientation=vertical]:w-auto data-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track
        data-slot="slider-track"
        className={cn(
          "relative grow overflow-hidden rounded-none bg-muted data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px"
        )}
      >
        <SliderPrimitive.Range
          data-slot="slider-range"
          className={cn(
            "absolute bg-primary data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"
          )}
        />
      </SliderPrimitive.Track>
      {Array.from({ length: _values.length }, (_, index) => (
        <SliderPrimitive.Thumb
          data-slot="slider-thumb"
          key={index}
          className="relative block h-3.5 w-[3px] shrink-0 cursor-grab rounded-none border-0 bg-white before:absolute before:-inset-x-2.5 before:-inset-y-1.5 before:content-[''] active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white disabled:pointer-events-none disabled:opacity-50"
        />
      ))}
    </SliderPrimitive.Root>
  )
}

export { Slider }
