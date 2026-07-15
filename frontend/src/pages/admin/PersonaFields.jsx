import {
    Accordion,
    FileInput,
    NumberInput,
    Stack,
    Text,
    Textarea,
    TextInput,
} from '@mantine/core'
import { createEmptyReferral, getPersonaLabel, normalizeReferral } from './Helpers.js'


function PersonaFields({ persona, updatePersona, errors = {} }) {
    return (
        <Stack gap="xs">
            <TextInput
                label="Persona name"
                placeholder="Enter persona name"
                required
                value={persona.name}
                error={errors.name}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((d) => {
                        d.name = value
                    })
                }}
            />
            <TextInput
                label="Title/Role"
                placeholder="Enter title or role"
                required
                value={persona.role}
                error={errors.role}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((d) => {
                        d.role = value
                    })
                }}
            />
            <FileInput
                label="Profile photo"
                placeholder="Upload a profile photo"
                accept="image/*"
                value={persona.profile_photo instanceof File ? persona.profile_photo : null}
                onChange={(value) => {
                    updatePersona((d) => {
                        d.profile_photo = value
                    })
                }}
                clearable
            />
            {persona.profile_photo && !(persona.profile_photo instanceof File) && (
                <Text size="xs" c="dimmed">
                    Existing photo: {persona.profile_photo.file_name}
                </Text>
            )}
            <Textarea
                label="Enter Persona Related Information"
                placeholder="Describe the persona's background, facts, and any other relevant information"
                minRows={3}
                autosize
                value={persona.known_facts}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((d) => {
                        d.known_facts = value
                    })
                }}
            />
            <Textarea
                label="Personality traits"
                placeholder="Describe personality traits"
                minRows={3}
                autosize
                value={persona.personality_traits}
                onChange={(event) => {
                    const value = event.currentTarget.value
                    updatePersona((d) => {
                        d.personality_traits = value
                    })
                }}
            />
            <NumberInput
                label="How long is this persona available for?"
                placeholder="Leave blank for unlimited"
                min={1}
                allowDecimal={false}
                hideControls
                value={persona.availability_minutes}
                error={errors.availability}
                onChange={(value) => {
                    updatePersona((d) => {
                        d.availability_minutes = value
                    })
                }}
            />
            <NumberInput
                label="How many files does this persona have access to?"
                placeholder="Leave empty for 0"
                min={0}
                allowDecimal={false}
                hideControls
                value={persona.file_count}
                error={errors.fileCount}
                onChange={(value) => {
                    updatePersona((d) => {
                        const count = typeof value === 'number' && value >= 0 ? value : null
                        d.file_count = count
                        if (typeof count === 'number') {
                            if (d.files.length > count) {
                                d.files.length = count
                            } else {
                                while (d.files.length < count) {
                                    d.files.push({
                                        file: null,
                                        share_conditions: '',
                                        perceived_contents: '',
                                    })
                                }
                            }
                        }
                    })
                }}
            />
            {typeof persona.file_count === 'number' && persona.file_count > 0 && (
                <Accordion variant="separated">
                    {Array.from({ length: persona.file_count }, (_, fileIndex) => {
                        const fileNumber = fileIndex + 1
                        const fileEntry = persona.files[fileIndex] ?? {
                            file: null,
                            share_conditions: '',
                            perceived_contents: '',
                        }
                        return (
                            <Accordion.Item
                                key={`persona-file-${fileNumber}`}
                                value={`persona-file-${fileNumber}`}
                            >
                                <Accordion.Control>File {fileNumber}</Accordion.Control>
                                <Accordion.Panel>
                                    <Stack gap="xs">
                                        <FileInput
                                            label="Upload file"
                                            placeholder="Select a file"
                                            value={
                                                fileEntry.file instanceof File
                                                    ? fileEntry.file
                                                    : null
                                            }
                                            onChange={(value) => {
                                                updatePersona((d) => {
                                                    d.files[fileIndex].file = value
                                                })
                                            }}
                                        />
                                        {fileEntry.file && !(fileEntry.file instanceof File) && (
                                            <Text size="xs" c="dimmed">
                                                Existing file: {fileEntry.file.file_name}
                                            </Text>
                                        )}
                                        <Textarea
                                            label="Describe the conditions under which the persona will share the file"
                                            placeholder="Describe the conditions"
                                            minRows={2}
                                            autosize
                                            value={fileEntry.share_conditions ?? ''}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((d) => {
                                                    d.files[fileIndex].share_conditions = value
                                                })
                                            }}
                                        />
                                        <Textarea
                                            label="What does the persona think is in this file?"
                                            placeholder="Describe perceived contents"
                                            minRows={2}
                                            autosize
                                            value={fileEntry.perceived_contents ?? ''}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((d) => {
                                                    d.files[fileIndex].perceived_contents = value
                                                })
                                            }}
                                        />
                                    </Stack>
                                </Accordion.Panel>
                            </Accordion.Item>
                        )
                    })}
                </Accordion>
            )}
            <NumberInput
                label="How many people does this persona refer out?"
                placeholder="Leave empty for none"
                min={0}
                allowDecimal={false}
                hideControls
                value={persona.referral_out_count}
                error={errors.referralOutCount}
                onChange={(value) => {
                    updatePersona((d) => {
                        const count = typeof value === 'number' && value >= 0 ? value : null
                        d.referral_out_count = count
                        if (typeof count !== 'number') {
                            d.referrals = []
                        } else if (d.referrals.length > count) {
                            d.referrals.length = count
                        } else {
                            while (d.referrals.length < count) {
                                d.referrals.push(createEmptyReferral())
                            }
                        }
                    })
                }}
            />
            {typeof persona.referral_out_count === 'number' && persona.referral_out_count > 0 && (
                <Accordion variant="separated">
                    {Array.from({ length: persona.referral_out_count }, (_, referralIndex) => {
                        const referral = normalizeReferral(persona.referrals[referralIndex])
                        return (
                            <Accordion.Item
                                key={`persona-referral-${referralIndex}`}
                                value={`persona-referral-${referralIndex}`}
                            >
                                <Accordion.Control>
                                    {getPersonaLabel({ name: referral.name }, 'Referred Persona')}
                                </Accordion.Control>
                                <Accordion.Panel>
                                    <Stack gap="xs">
                                        <TextInput
                                            label="Name"
                                            placeholder="Enter name"
                                            value={referral.name}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((d) => {
                                                    d.referrals[referralIndex] = normalizeReferral(
                                                        d.referrals[referralIndex],
                                                    )
                                                    d.referrals[referralIndex].name = value
                                                    d.referrals[referralIndex].persona.name = value
                                                })
                                            }}
                                        />
                                        <Textarea
                                            label="Describe the referral conditions"
                                            placeholder="Describe the referral conditions"
                                            minRows={2}
                                            autosize
                                            value={referral.conditions}
                                            onChange={(event) => {
                                                const value = event.currentTarget.value
                                                updatePersona((d) => {
                                                    d.referrals[referralIndex] = normalizeReferral(
                                                        d.referrals[referralIndex],
                                                    )
                                                    d.referrals[referralIndex].conditions = value
                                                })
                                            }}
                                        />
                                    </Stack>
                                </Accordion.Panel>
                            </Accordion.Item>
                        )
                    })}
                </Accordion>
            )}
        </Stack>
    )
}

export default PersonaFields
