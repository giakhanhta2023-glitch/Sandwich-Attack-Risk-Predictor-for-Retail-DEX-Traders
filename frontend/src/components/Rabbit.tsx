import { cn } from '@/lib/utils'

/**
 * The site's pixel rabbit.
 *
 * Drawn as tiny animated GIFs in `public/pixel` (16x16, a few hundred bytes
 * each) and scaled up with `image-rendering: pixelated`, so they stay sharp
 * instead of turning to mush. Every one is decorative and hidden from screen
 * readers: the numbers beside them carry the meaning.
 */
const POSE = {
  idle: '/pixel/rabbit-idle.gif',
  hop: '/pixel/rabbit-hop.gif',
  run: '/pixel/rabbit-run.gif',
  alert: '/pixel/rabbit-alert.gif',
  sleep: '/pixel/rabbit-sleep.gif',
  eat: '/pixel/rabbit-eat.gif',
  heart: '/pixel/rabbit-heart.gif',
  coin: '/pixel/rabbit-coin.gif',
  sparkle: '/pixel/rabbit-sparkle.gif',
  question: '/pixel/rabbit-question.gif',
  cry: '/pixel/rabbit-cry.gif',
  wave: '/pixel/rabbit-wave.gif',
} as const

export type RabbitPose = keyof typeof POSE

export function Rabbit({
  pose = 'hop',
  size = 16,
  className,
  title,
}: {
  pose?: RabbitPose
  size?: number
  className?: string
  title?: string
}) {
  return (
    <img
      src={POSE[pose]}
      alt=""
      aria-hidden
      draggable={false}
      title={title}
      style={{ width: size, height: 'auto' }}
      className={cn('pixel shrink-0 select-none', className)}
    />
  )
}
