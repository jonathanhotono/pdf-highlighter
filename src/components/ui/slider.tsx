import * as React from "react"
import { cn } from "@/lib/utils"

interface SliderProps {
  value: number[]
  min?: number
  max?: number
  step?: number
  onValueChange: (value: number[]) => void
  className?: string
}

const Slider = React.forwardRef<HTMLDivElement, SliderProps>(
  ({ value, min = 0, max = 100, step = 1, onValueChange, className }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onValueChange([parseFloat(e.target.value)])
    }

    return (
      <div ref={ref} className={cn("relative flex items-center", className)}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value[0]}
          onChange={handleChange}
          className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer slider-thumb"
          style={{
            background: `linear-gradient(to right, rgb(15 23 42) 0%, rgb(15 23 42) ${((value[0] - min) / (max - min)) * 100}%, rgb(226 232 240) ${((value[0] - min) / (max - min)) * 100}%, rgb(226 232 240) 100%)`
          }}
        />
        <style>{`
          input[type='range']::-webkit-slider-thumb {
            appearance: none;
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: rgb(15 23 42);
            cursor: pointer;
          }
          input[type='range']::-moz-range-thumb {
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: rgb(15 23 42);
            cursor: pointer;
            border: none;
          }
        `}</style>
      </div>
    )
  }
)
Slider.displayName = "Slider"

export { Slider }
